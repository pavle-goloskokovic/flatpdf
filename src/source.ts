import { openPdfSource } from './flatten';

/** One page of an opened document. Sizes are in points (1/72 inch). */
export interface SourcePage
{
    readonly width: number;
    readonly height: number;
    /** Draws the page at `scale` canvas pixels per point, from the canvas's top-left corner. */
    render (ctx: CanvasRenderingContext2D, scale: number): Promise<void>;
    cleanup (): void;
}

/** A document whose pages can be drawn to a canvas: a PDF or a Word document. */
export interface SourceDocument
{
    readonly numPages: number;
    /** `number` is 1-based. */
    getPage (number: number): Promise<SourcePage>;
    close (): Promise<void>;
}

export interface OpenOptions
{
    /** Password to try first on an encrypted PDF. */
    password?: string;
    /** See `PageRenderer`; only PDFs have screen-only content. */
    printableOnly: boolean;
    /** Called for encrypted PDFs. Return null to give up. */
    askPassword?: (retry: boolean) => string | null;
}

/** A file that cannot be opened. The message is written for the user. */
export class UnsupportedFileError extends Error
{
    constructor (message: string)
    {
        super(message);
        this.name = 'UnsupportedFileError';
    }
}

/**
 * A copy of the file held in memory. A `File` from a file picker or a drop only
 * points at the file on disk, and stops being readable once that file is
 * renamed, moved, changed or deleted.
 */
export async function copyToMemory (file: File): Promise<File>
{
    return new File([await file.arrayBuffer()], file.name, { type: file.type, lastModified: file.lastModified });
}

/** True for the error a browser raises when a file on disk can no longer be read. */
export function isUnreadableFile (error: unknown): boolean
{
    return error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'NotReadableError');
}

export type FileKind = 'pdf' | 'word' | 'old-word' | 'other';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function fileKind (file: File): FileKind
{
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name))
    {
        return 'pdf';
    }
    if (file.type === DOCX_TYPE || /\.docx$/i.test(file.name))
    {
        return 'word';
    }
    if (file.type === 'application/msword' || /\.doc$/i.test(file.name))
    {
        return 'old-word';
    }
    return 'other';
}

/** Why a file of this kind cannot be flattened, or '' when it can. */
export function unsupportedReason (kind: FileKind): string
{
    switch (kind)
    {
        case 'old-word':
            return 'Old .doc files are not supported. Save it as .docx in Word and add it again.';
        case 'other':
            return 'Not a PDF or Word file. Only .pdf and .docx files can be flattened.';
        default:
            return '';
    }
}

/** Opens a PDF or a Word document. The Word reader is downloaded the first time it is needed. */
export async function openSource (file: File, options: OpenOptions): Promise<SourceDocument>
{
    const kind = fileKind(file);
    if (kind === 'pdf')
    {
        return openPdfSource(await file.arrayBuffer(), options);
    }
    if (kind === 'word')
    {
        const { openDocx } = await import('./docx');
        return openDocx(await file.arrayBuffer());
    }
    throw new UnsupportedFileError(unsupportedReason(kind));
}
