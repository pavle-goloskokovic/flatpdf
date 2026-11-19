import qrcode from 'qrcode-generator';

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

/** Light border every QR code needs around it, in modules. */
export const QUIET_ZONE = 4;

export interface MadeQr
{
    /** 1 to 40; a symbol is `version * 4 + 17` modules wide. */
    version: number;
    modules: number;
    isDark: (row: number, column: number) => boolean;
}

export function modulesOf (version: number): number
{
    return version * 4 + 17;
}

/**
 * Encodes bytes at the given error correction level in the smallest version
 * from `minVersion` up that holds them. Returns null when not even the largest
 * version does.
 */
export function makeQr (bytes: Uint8Array, minVersion: number, ecLevel: EcLevel): MadeQr | null
{
    // The library takes byte data as a string with one character per byte.
    let data = '';
    for (const byte of bytes)
    {
        data += String.fromCharCode(byte);
    }
    for (let version = Math.min(Math.max(minVersion, 1), 40); version <= 40; version++)
    {
        const qr = qrcode(version as TypeNumber, ecLevel);
        qr.addData(data, 'Byte');
        try
        {
            qr.make();
        }
        catch
        {
            // Too much data for this version; try the next one.
            continue;
        }
        return { version, modules: qr.getModuleCount(), isDark: (row, column) => qr.isDark(row, column) };
    }
    return null;
}

/** Draws the code in black on white, `cell` pixels per module, with its quiet zone. */
export function drawQr (qr: MadeQr, cell: number): HTMLCanvasElement
{
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = (qr.modules + QUIET_ZONE * 2) * cell;
    const ctx = canvas.getContext('2d');
    if (!ctx)
    {
        throw new Error('Could not draw the QR code.');
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let row = 0; row < qr.modules; row++)
    {
        for (let column = 0; column < qr.modules; column++)
        {
            if (qr.isDark(row, column))
            {
                ctx.fillRect((column + QUIET_ZONE) * cell, (row + QUIET_ZONE) * cell, cell, cell);
            }
        }
    }
    return canvas;
}
