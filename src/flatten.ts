import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSETS = new URL('./pdfjs/', document.baseURI).href;

/** Keep a single page bitmap within what every browser can allocate. */
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;

export interface FlattenOptions
{
    /** Raster resolution in dots per inch (PDF user space is 72 per inch). */
    dpi: number;
    /** JPEG quality, 0..1. */
    quality: number;
    grayscale: boolean;
}

export interface FlattenCallbacks
{
    onProgress?: (done: number, total: number) => void;
    /** Return true to stop; `flatten` then throws `CancelledError`. */
    isCancelled?: () => boolean;
    /** Called for encrypted files. Return null to give up. */
    askPassword?: (retry: boolean) => string | null;
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

function toGrayscale (ctx: CanvasRenderingContext2D, width: number, height: number): void
{
    const image = ctx.getImageData(0, 0, width, height);
    const px = image.data;
    for (let i = 0; i < px.length; i += 4)
    {
        const y = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
        px[i] = px[i + 1] = px[i + 2] = y;
    }
    ctx.putImageData(image, 0, 0);
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
 * Renders every page of `data` to a JPEG and returns a new PDF whose pages are
 * those images at the original page size. Text, vectors, layers, forms and
 * annotations all end up as pixels.
 */
export async function flatten (
    data: ArrayBuffer,
    options: FlattenOptions,
    callbacks: FlattenCallbacks = {},
): Promise<Uint8Array>
{
    const { onProgress, isCancelled, askPassword } = callbacks;
    const checkCancelled = (): void =>
    {
        if (isCancelled?.())
        {
            throw new CancelledError();
        }
    };

    const task = pdfjs.getDocument({
        data: new Uint8Array(data),
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
        const password = askPassword?.(retry) ?? null;
        if (password === null)
        {
            passwordRefused = true;
            void task.destroy();
        }
        else
        {
            update(password);
        }
    };

    let source: pdfjs.PDFDocumentProxy;
    try
    {
        source = await task.promise;
    }
    catch (error)
    {
        if (passwordRefused || (error instanceof Error && error.name === 'PasswordException'))
        {
            throw new PasswordError();
        }
        throw error;
    }

    try
    {
        const output = await PDFDocument.create();
        const total = source.numPages;
        onProgress?.(0, total);

        for (let n = 1; n <= total; n++)
        {
            checkCancelled();

            const page = await source.getPage(n);
            // Size in points, with page rotation and UserUnit already applied.
            const size = page.getViewport({ scale: 1 });

            let scale = options.dpi / 72;
            scale = Math.min(
                scale,
                MAX_SIDE / size.width,
                MAX_SIDE / size.height,
                Math.sqrt(MAX_PIXELS / (size.width * size.height)),
            );
            const viewport = page.getViewport({ scale });

            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(viewport.width));
            canvas.height = Math.max(1, Math.round(viewport.height));
            const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: options.grayscale });
            if (!ctx)
            {
                throw new Error('The browser could not create a canvas for this page.');
            }

            try
            {
                await page.render({ canvas: null, canvasContext: ctx, viewport }).promise;
                checkCancelled();

                if (options.grayscale)
                {
                    toGrayscale(ctx, canvas.width, canvas.height);
                }

                const jpeg = await encodeJpeg(canvas, options.quality);
                const image = await output.embedJpg(jpeg);
                output.addPage([size.width, size.height]).drawImage(image, {
                    x: 0,
                    y: 0,
                    width: size.width,
                    height: size.height,
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
        await task.destroy();
    }
}
