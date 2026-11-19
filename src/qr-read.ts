import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { openPdf, PageRenderer } from './flatten';
import { modulesOf, QUIET_ZONE, type EcLevel } from './qr-make';

// The library would otherwise fetch its decoder from a CDN; serve our own copy
// so the page never calls a third-party host. Start fetching it right away:
// this module is only loaded once the user has asked for the QR tool.
prepareZXingModule({
    overrides: {
        locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
    },
    fireImmediately: true,
}).catch(() =>
{
    // Reading a code tries again and reports the failure.
});

/** PDF pages are read at print scale, like the image editor works. */
const PDF_DPI = 300;
const MAX_PIXELS = 16_000_000;
const MAX_PDF_PAGES = 50;

export interface ScannedQr
{
    bytes: Uint8Array;
    /** The bytes read as UTF-8. */
    text: string;
    version: number;
    ecLevel: EcLevel;
    /** Width of one module in the source, in source pixels. */
    moduleSize: number;
    /** The code cut out of the source, with its quiet zone. */
    crop: HTMLCanvasElement;
    /** Set when the code came from a PDF page. */
    page?: number;
}

function newCanvas (width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D]
{
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx)
    {
        throw new Error('This browser could not create a canvas.');
    }
    return [canvas, ctx];
}

async function scanCanvas (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Promise<ScannedQr[]>
{
    const results = await readBarcodes(ctx.getImageData(0, 0, canvas.width, canvas.height), {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        tryDownscale: true,
        maxNumberOfSymbols: 8,
    });
    const found: ScannedQr[] = [];
    for (const result of results)
    {
        const version = Number.parseInt(result.version, 10);
        const { ecLevel } = result;
        if (!result.isValid || !(version >= 1 && version <= 40)
            || (ecLevel !== 'L' && ecLevel !== 'M' && ecLevel !== 'Q' && ecLevel !== 'H'))
        {
            continue;
        }
        const { topLeft, topRight, bottomLeft, bottomRight } = result.position;
        const side = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
            Math.hypot(a.x - b.x, a.y - b.y);
        const moduleSize = (side(topLeft, topRight) + side(bottomLeft, bottomRight)
            + side(topLeft, bottomLeft) + side(topRight, bottomRight)) / 4 / modulesOf(version);

        const xs = [topLeft.x, topRight.x, bottomLeft.x, bottomRight.x];
        const ys = [topLeft.y, topRight.y, bottomLeft.y, bottomRight.y];
        const pad = moduleSize * QUIET_ZONE;
        const left = Math.max(0, Math.floor(Math.min(...xs) - pad));
        const top = Math.max(0, Math.floor(Math.min(...ys) - pad));
        const right = Math.min(canvas.width, Math.ceil(Math.max(...xs) + pad));
        const bottom = Math.min(canvas.height, Math.ceil(Math.max(...ys) + pad));
        const [crop, cropCtx] = newCanvas(right - left, bottom - top);
        cropCtx.drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);

        found.push({
            bytes: result.bytes,
            text: new TextDecoder().decode(result.bytes),
            version,
            ecLevel,
            moduleSize,
            crop,
        });
    }
    return found;
}

/** Finds the QR codes in an image file. */
export async function scanImage (file: Blob): Promise<ScannedQr[]>
{
    let bitmap: ImageBitmap;
    try
    {
        bitmap = await createImageBitmap(file);
    }
    catch
    {
        throw new Error('This file is not an image this browser can open.');
    }
    try
    {
        const fit = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
        const [canvas, ctx] = newCanvas(bitmap.width * fit, bitmap.height * fit);
        // A transparent background would otherwise read as black.
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const found = await scanCanvas(canvas, ctx);
        // Report module sizes in the pixels of the file, not of a shrunken copy.
        return found.map((qr) => ({ ...qr, moduleSize: qr.moduleSize / fit }));
    }
    finally
    {
        bitmap.close();
    }
}

/**
 * Looks through the pages of a PDF and returns the codes of the first page
 * that has one `wanted` accepts, or else every code found.
 */
export async function scanPdf (
    data: ArrayBuffer,
    askPassword: (retry: boolean) => string | null,
    wanted: (qr: ScannedQr) => boolean,
): Promise<ScannedQr[]>
{
    const pdf = await openPdf(data, undefined, askPassword);
    try
    {
        const renderer = new PageRenderer(pdf.doc, false);
        const all: ScannedQr[] = [];
        const pages = Math.min(pdf.doc.numPages, MAX_PDF_PAGES);
        for (let number = 1; number <= pages; number++)
        {
            const page = await pdf.doc.getPage(number);
            try
            {
                const size = page.getViewport({ scale: 1 });
                const scale = Math.min(PDF_DPI / 72, Math.sqrt(MAX_PIXELS / (size.width * size.height)));
                const viewport = page.getViewport({ scale });
                const [canvas, ctx] = newCanvas(viewport.width, viewport.height);
                await renderer.render(page, ctx, viewport);
                const found = (await scanCanvas(canvas, ctx)).map((qr) => ({ ...qr, page: number }));
                if (found.some(wanted))
                {
                    return found;
                }
                all.push(...found);
            }
            finally
            {
                page.cleanup();
            }
        }
        return all;
    }
    finally
    {
        await pdf.close();
    }
}
