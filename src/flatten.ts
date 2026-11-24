import { PDFDocument, PDFDropdown, PDFOptionList } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { OpenOptions, SourceDocument } from './source';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSETS = new URL('./pdfjs/', document.baseURI).href;

/** Keep a single page bitmap within what every browser can allocate. */
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;

/** Speck density over text for each OCR protection level. */
const SPECKS_PER_SQUARE_INCH = { off: 0, light: 300, strong: 600 } as const;

export interface FlattenOptions
{
    /** Raster resolution in dots per inch (PDF user space is 72 per inch). */
    dpi: number;
    /** JPEG quality, 0..1. */
    quality: number;
    grayscale: boolean;
    /**
     * How strongly to disturb the text so OCR struggles while people can still
     * read it. Stronger settings are harder on both.
     */
    ocrProtection: 'off' | 'light' | 'strong';
    /** Images to draw onto pages before they are flattened. */
    overlays?: readonly Overlay[];
}

/** An image placed on a page. Position and size are in points from the page's top-left corner. */
export interface Overlay
{
    /** 1-based page number. */
    page: number;
    source: CanvasImageSource;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface FlattenCallbacks
{
    onProgress?: (done: number, total: number) => void;
    /** Receives the flattened first page as a JPEG, as soon as it is ready. */
    onPreview?: (jpeg: Blob) => void;
    /** Return true to stop; `flatten` then throws `CancelledError`. */
    isCancelled?: () => boolean;
}

export class CancelledError extends Error
{
    constructor ()
    {
        super('Cancelled');
        this.name = 'CancelledError';
    }
}

export class PasswordError extends Error
{
    constructor ()
    {
        super('Password required');
        this.name = 'PasswordError';
    }
}

function toGrayscale (px: Uint8ClampedArray): void
{
    for (let i = 0; i < px.length; i += 4)
    {
        const y = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
        px[i] = px[i + 1] = px[i + 2] = y;
    }
}

/** Sum of two sine waves with random phase and period, sampled per pixel. */
function wave (length: number, amplitude: number, pxPerInch: number): Float32Array
{
    const out = new Float32Array(length);
    const k1 = 2 * Math.PI / (pxPerInch * (0.45 + Math.random() * 0.35));
    const k2 = 2 * Math.PI / (pxPerInch * (1.1 + Math.random() * 0.9));
    const p1 = Math.random() * 2 * Math.PI;
    const p2 = Math.random() * 2 * Math.PI;
    for (let i = 0; i < length; i++)
    {
        out[i] = amplitude * (0.6 * Math.sin(i * k1 + p1) + Math.sin(i * k2 + p2));
    }
    return out;
}

/**
 * Bends the page slightly: text baselines become gentle waves and glyphs lean
 * a little differently along each line, which upsets OCR line finding.
 */
function warp (px: Uint8ClampedArray, width: number, height: number, pxPerInch: number): void
{
    const src = px.slice();
    const amplitude = pxPerInch * 0.02;
    const shiftX = wave(height, amplitude, pxPerInch);
    const shiftY = wave(width, amplitude, pxPerInch);
    const maxX = width - 1;
    const maxY = height - 1;

    for (let y = 0; y < height; y++)
    {
        const dx = shiftX[y];
        for (let x = 0; x < width; x++)
        {
            let sx = x + dx;
            let sy = y + shiftY[x];
            sx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
            sy = sy < 0 ? 0 : sy > maxY ? maxY : sy;
            const x0 = sx | 0;
            const y0 = sy | 0;
            const x1 = x0 < maxX ? x0 + 1 : x0;
            const y1 = y0 < maxY ? y0 + 1 : y0;
            const fx = sx - x0;
            const fy = sy - y0;
            const a = (y0 * width + x0) * 4;
            const b = (y0 * width + x1) * 4;
            const c = (y1 * width + x0) * 4;
            const d = (y1 * width + x1) * 4;
            const o = (y * width + x) * 4;
            for (let ch = 0; ch < 3; ch++)
            {
                const top = src[a + ch] + (src[b + ch] - src[a + ch]) * fx;
                const bottom = src[c + ch] + (src[d + ch] - src[c + ch]) * fx;
                px[o + ch] = top + (bottom - top) * fy;
            }
        }
    }
}

/**
 * Scatters short strokes, about as thick as a letter stroke and in the same
 * colour as the text, over areas that contain text. They touch and bridge
 * glyphs, so OCR cannot separate characters cleanly, while a reader still
 * sees the letter shapes. Blank areas are left clean.
 */
function drawSpecks (
    ctx: CanvasRenderingContext2D,
    px: Uint8ClampedArray,
    width: number,
    height: number,
    pxPerInch: number,
    perSquareInch: number,
): void
{
    const cellInches = 0.07;
    const cell = Math.max(2, Math.round(cellInches * pxPerInch));
    const perCell = perSquareInch * cellInches * cellInches;
    const stroke = 0.008 * pxPerInch;

    ctx.save();
    ctx.lineCap = 'butt';
    for (let cy = 0; cy + cell <= height; cy += cell)
    {
        for (let cx = 0; cx + cell <= width; cx += cell)
        {
            // Find the darkest and lightest pixel of the cell.
            let min = 255;
            let max = 0;
            let minAt = 0;
            let maxAt = 0;
            let sum = 0;
            for (let y = cy; y < cy + cell; y++)
            {
                let i = (y * width + cx) * 4;
                for (let x = 0; x < cell; x++, i += 4)
                {
                    const l = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
                    sum += l;
                    if (l < min)
                    {
                        min = l;
                        minAt = i;
                    }
                    if (l > max)
                    {
                        max = l;
                        maxAt = i;
                    }
                }
            }
            // Only cells with ink on paper (or light text on a dark fill).
            if (max - min < 90)
            {
                continue;
            }
            const darkOnLight = sum / (cell * cell) > 128;
            const at = darkOnLight ? minAt : maxAt;
            ctx.strokeStyle = `rgba(${px[at]},${px[at + 1]},${px[at + 2]},0.9)`;

            let count = Math.floor(perCell);
            if (Math.random() < perCell - count)
            {
                count++;
            }
            for (let n = 0; n < count; n++)
            {
                const x = cx + Math.random() * cell;
                const y = cy + Math.random() * cell;
                const thickness = stroke * (0.6 + Math.random() * 0.8);
                const half = thickness / 2 * (1 + Math.random() * 3);
                const angle = Math.random() * Math.PI;
                const ax = Math.cos(angle) * half;
                const ay = Math.sin(angle) * half;
                ctx.lineWidth = thickness;
                ctx.beginPath();
                ctx.moveTo(x - ax, y - ay);
                ctx.lineTo(x + ax, y + ay);
                ctx.stroke();
            }
        }
    }
    ctx.restore();
}

/**
 * Stored values of dropdown and list fields, by field name, read straight from
 * the file. Empty when the file cannot be read this way (e.g. encrypted).
 */
async function readChoiceValues (source: pdfjs.PDFDocumentProxy): Promise<Map<string, string[]>>
{
    const values = new Map<string, string[]>();
    try
    {
        const doc = await PDFDocument.load(await source.getData(), { updateMetadata: false });
        for (const field of doc.getForm().getFields())
        {
            if (field instanceof PDFDropdown || field instanceof PDFOptionList)
            {
                const selected = field.getSelected();
                if (selected.length > 0)
                {
                    values.set(field.getName(), selected);
                }
            }
        }
    }
    catch
    {
        // Fall back to what pdf.js reports.
    }
    return values;
}

/** PDF annotation flag: the annotation is meant to appear on paper. */
const FLAG_PRINT = 4;
/** PDF annotation flags: never shown / shown on paper but not on screen. */
const FLAG_HIDDEN = 2;
const FLAG_NO_VIEW = 32;

/**
 * True for push buttons that are controls of the interactive form (Reset,
 * Submit, Print...) rather than content. A push button carries no value, so it
 * is dropped when the author marked it screen-only or when it resets the form
 * or opens a link. Printable buttons with other actions are kept, because
 * "image fields" that hold a picture are built that way.
 */
function isCommandButton (annotation: Record<string, any>): boolean
{
    if (annotation.subtype !== 'Widget' || !annotation.pushButton)
    {
        return false;
    }
    const printable = ((annotation.annotationFlags ?? 0) & FLAG_PRINT) !== 0;
    return !printable || Boolean(annotation.resetForm) || Boolean(annotation.url);
}

export interface OpenedPdf
{
    doc: pdfjs.PDFDocumentProxy;
    close: () => Promise<void>;
}

/**
 * Opens a PDF with pdf.js. `password` is tried first; `askPassword` is called
 * when it is missing or wrong. Throws `PasswordError` when no password works.
 */
export async function openPdf (
    data: ArrayBuffer,
    password?: string,
    askPassword?: (retry: boolean) => string | null,
): Promise<OpenedPdf>
{
    const task = pdfjs.getDocument({
        data: new Uint8Array(data),
        password,
        cMapUrl: ASSETS + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: ASSETS + 'standard_fonts/',
        wasmUrl: ASSETS + 'wasm/',
        iccUrl: ASSETS + 'iccs/',
        // Pages are read back from the canvas right after rendering, so keep
        // rendering on this thread with a plain 2D canvas.
        disableWorkerRendering: true,
    });

    let passwordRefused = false;
    task.onPassword = (update: (password: string) => void, reason: number) =>
    {
        const retry = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
        const entered = askPassword?.(retry) ?? null;
        if (entered === null)
        {
            passwordRefused = true;
            void task.destroy();
        }
        else
        {
            update(entered);
        }
    };

    try
    {
        const doc = await task.promise;
        return { doc, close: () => task.destroy() };
    }
    catch (error)
    {
        if (passwordRefused || (error instanceof Error && error.name === 'PasswordException'))
        {
            throw new PasswordError();
        }
        throw error;
    }
}

/**
 * Draws pages of one document the way the flattened output shows them: form
 * values are always drawn, form command buttons never are. With
 * `printableOnly` the output is the printed version: every annotation the PDF
 * does not mark as printable is left out, and print-only ones are included.
 */
export class PageRenderer
{
    private readonly doc: pdfjs.PDFDocumentProxy;
    private readonly printableOnly: boolean;
    private choiceValues: Map<string, string[]> | undefined;

    constructor (doc: pdfjs.PDFDocumentProxy, printableOnly: boolean)
    {
        this.doc = doc;
        this.printableOnly = printableOnly;
    }

    async render (
        page: pdfjs.PDFPageProxy,
        ctx: CanvasRenderingContext2D,
        viewport: ReturnType<pdfjs.PDFPageProxy['getViewport']>,
    ): Promise<void>
    {
        const storage = this.doc.annotationStorage;

        // A form field normally carries a ready-made drawing of its value.
        // Some tools store only the value; pdf.js then draws nothing, so
        // hand those values back to it and let it draw them itself.
        for (const annotation of await page.getAnnotations({ intent: 'any' }))
        {
            const { fieldType } = annotation;
            if (isCommandButton(annotation))
            {
                storage.setValue(annotation.id, { noView: true });
                continue;
            }
            if (this.printableOnly)
            {
                const flags: number = annotation.annotationFlags ?? 0;
                if ((flags & FLAG_PRINT) === 0)
                {
                    storage.setValue(annotation.id, { noView: true });
                    continue;
                }
                if ((flags & FLAG_NO_VIEW) !== 0 && (flags & FLAG_HIDDEN) === 0)
                {
                    storage.setValue(annotation.id, { noView: false });
                }
            }
            if (
                annotation.subtype !== 'Widget'
                || (fieldType !== 'Tx' && fieldType !== 'Ch')
                || annotation.hasAppearance
            )
            {
                continue;
            }
            let value: unknown = annotation.fieldValue;
            if (fieldType === 'Ch')
            {
                // pdf.js derives a list's value from its selected-index
                // entry; when that disagrees with the stored value, the
                // PDF spec says the stored value wins.
                this.choiceValues ??= await readChoiceValues(this.doc);
                value = this.choiceValues.get(annotation.fieldName) ?? value;
            }
            const filled = Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value !== '';
            if (filled)
            {
                storage.setValue(annotation.id, { value });
            }
        }

        await page.render({
            canvas: null,
            canvasContext: ctx,
            viewport,
            annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE,
        }).promise;
    }
}

/** Opens a PDF as a document whose pages `flatten` and the image editor can draw. */
export async function openPdfSource (data: ArrayBuffer, options: OpenOptions): Promise<SourceDocument>
{
    const { doc, close } = await openPdf(data, options.password, options.askPassword);
    const renderer = new PageRenderer(doc, options.printableOnly);
    return {
        numPages: doc.numPages,
        async getPage (number)
        {
            const page = await doc.getPage(number);
            // Size in points, with page rotation and UserUnit already applied.
            const size = page.getViewport({ scale: 1 });
            return {
                width: size.width,
                height: size.height,
                render: (ctx, scale) => renderer.render(page, ctx, page.getViewport({ scale })),
                cleanup: () =>
                {
                    page.cleanup();
                },
            };
        },
        close,
    };
}

function encodeJpeg (canvas: HTMLCanvasElement, quality: number): Promise<ArrayBuffer>
{
    return new Promise((resolve, reject) =>
    {
        canvas.toBlob((blob) =>
        {
            if (blob)
            {
                resolve(blob.arrayBuffer());
            }
            else
            {
                reject(new Error('The browser could not encode the page image.'));
            }
        }, 'image/jpeg', quality);
    });
}

/**
 * Renders every page of `source` to a JPEG and returns a new PDF whose pages
 * are those images at the original page size. Text, vectors, layers, forms and
 * annotations all end up as pixels. Closes `source` when done.
 */
export async function flatten (
    source: SourceDocument,
    options: FlattenOptions,
    callbacks: FlattenCallbacks = {},
): Promise<Uint8Array>
{
    const { onProgress, onPreview, isCancelled } = callbacks;
    const checkCancelled = (): void =>
    {
        if (isCancelled?.())
        {
            throw new CancelledError();
        }
    };

    try
    {
        const output = await PDFDocument.create();
        const total = source.numPages;
        onProgress?.(0, total);

        for (let n = 1; n <= total; n++)
        {
            checkCancelled();

            const page = await source.getPage(n);

            let scale = options.dpi / 72;
            scale = Math.min(
                scale,
                MAX_SIDE / page.width,
                MAX_SIDE / page.height,
                Math.sqrt(MAX_PIXELS / (page.width * page.height)),
            );

            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(page.width * scale));
            canvas.height = Math.max(1, Math.round(page.height * scale));
            const specks = SPECKS_PER_SQUARE_INCH[options.ocrProtection];
            const editPixels = options.grayscale || specks > 0;
            const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: editPixels });
            if (!ctx)
            {
                throw new Error('The browser could not create a canvas for this page.');
            }

            try
            {
                await page.render(ctx, scale);

                ctx.imageSmoothingQuality = 'high';
                for (const overlay of options.overlays ?? [])
                {
                    if (overlay.page === n)
                    {
                        ctx.drawImage(overlay.source, overlay.x * scale, overlay.y * scale, overlay.width * scale, overlay.height * scale);
                    }
                }
                checkCancelled();

                if (editPixels)
                {
                    const pxPerInch = scale * 72;
                    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    if (specks)
                    {
                        warp(image.data, canvas.width, canvas.height, pxPerInch);
                    }
                    if (options.grayscale)
                    {
                        toGrayscale(image.data);
                    }
                    ctx.putImageData(image, 0, 0);
                    if (specks)
                    {
                        drawSpecks(ctx, image.data, canvas.width, canvas.height, pxPerInch, specks);
                    }
                }

                const jpeg = await encodeJpeg(canvas, options.quality);
                if (n === 1)
                {
                    onPreview?.(new Blob([jpeg], { type: 'image/jpeg' }));
                }
                const image = await output.embedJpg(jpeg);
                output.addPage([page.width, page.height]).drawImage(image, {
                    x: 0,
                    y: 0,
                    width: page.width,
                    height: page.height,
                });
            }
            finally
            {
                // Release the bitmap now instead of waiting for GC.
                canvas.width = canvas.height = 0;
                page.cleanup();
            }

            onProgress?.(n, total);
        }

        checkCancelled();
        return await output.save();
    }
    finally
    {
        await source.close();
    }
}
