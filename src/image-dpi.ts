/**
 * Reads the resolution an image file declares for itself, in dots per inch.
 * Returns null when the file stores none (or the format has no such field).
 */
export function readImageDpi (bytes: Uint8Array): number | null
{
    const dpi = isPng(bytes) ? pngDpi(bytes) : isJpeg(bytes) ? jpegDpi(bytes) : null;
    if (dpi === null || dpi < 10 || dpi > 10_000)
    {
        return null;
    }
    // PNG stores whole pixels per metre, so 96 dpi comes back as 96.012.
    const whole = Math.round(dpi);
    return Math.abs(dpi - whole) < 0.05 ? whole : Math.round(dpi * 100) / 100;
}

function isPng (b: Uint8Array): boolean
{
    return b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

function isJpeg (b: Uint8Array): boolean
{
    return b.length > 4 && b[0] === 0xff && b[1] === 0xd8;
}

function ascii (b: Uint8Array, at: number, length: number): string
{
    return String.fromCharCode(...b.subarray(at, at + length));
}

/** PNG: the pHYs chunk holds pixels per metre. */
function pngDpi (b: Uint8Array): number | null
{
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let at = 8;
    while (at + 12 <= b.length)
    {
        const length = view.getUint32(at);
        const type = ascii(b, at + 4, 4);
        if (type === 'pHYs' && at + 17 <= b.length)
        {
            const perMetre = view.getUint32(at + 8);
            const unit = b[at + 16];
            return unit === 1 ? perMetre * 0.0254 : null;
        }
        if (type === 'IDAT' || type === 'IEND')
        {
            break;
        }
        at += 12 + length;
    }
    return null;
}

/** JPEG: EXIF XResolution when present, otherwise the JFIF density. */
function jpegDpi (b: Uint8Array): number | null
{
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let jfif: number | null = null;
    let at = 2;
    while (at + 4 <= b.length && b[at] === 0xff)
    {
        const marker = b[at + 1];
        if (marker === 0xda || marker === 0xd9)
        {
            break;
        }
        const length = view.getUint16(at + 2);
        const body = at + 4;
        if (marker === 0xe0 && ascii(b, body, 5) === 'JFIF\0' && body + 12 <= b.length)
        {
            const unit = b[body + 7];
            const density = view.getUint16(body + 8);
            jfif = unit === 1 ? density : unit === 2 ? density * 2.54 : null;
        }
        else if (marker === 0xe1 && ascii(b, body, 6) === 'Exif\0\0')
        {
            const exif = exifDpi(view, body + 6, at + 2 + length);
            if (exif !== null)
            {
                return exif;
            }
        }
        at += 2 + length;
    }
    return jfif;
}

function exifDpi (view: DataView, tiff: number, end: number): number | null
{
    if (tiff + 8 > end)
    {
        return null;
    }
    const little = view.getUint16(tiff) === 0x4949;
    const ifd = tiff + view.getUint32(tiff + 4, little);
    if (ifd + 2 > end)
    {
        return null;
    }
    const count = view.getUint16(ifd, little);
    let resolution: number | null = null;
    let unit = 2;
    for (let i = 0; i < count; i++)
    {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > end)
        {
            break;
        }
        const tag = view.getUint16(entry, little);
        if (tag === 0x011a)
        {
            const value = tiff + view.getUint32(entry + 8, little);
            if (value + 8 <= end)
            {
                const denominator = view.getUint32(value + 4, little);
                resolution = denominator ? view.getUint32(value, little) / denominator : null;
            }
        }
        else if (tag === 0x0128)
        {
            unit = view.getUint16(entry + 8, little);
        }
    }
    if (resolution === null)
    {
        return null;
    }
    return unit === 3 ? resolution * 2.54 : resolution;
}
