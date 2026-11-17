import { openPdf, PageRenderer, type OpenedPdf } from './flatten';
import { readImageDpi } from './image-dpi';

/** The editor works at print scale: one image pixel is 1/300 inch. */
const EDITOR_DPI = 300;
const POINTS_PER_INCH = 72;
const MM_PER_INCH = 25.4;
/** Smallest size an image can be dragged down to, in points. */
const MIN_SIZE = 6;
/** How much of an image must stay on the page, in points. */
const KEEP_ON_PAGE = 8;

/** An image the user has added in this session. */
export interface StampImage
{
    name: string;
    url: string;
    element: HTMLImageElement;
    /** Size in pixels. */
    width: number;
    height: number;
    /** Resolution stored in the file, if any. */
    dpi: number | null;
}

/** One image placed on one page. Position and size are in points from the page's top-left corner. */
export interface Placement
{
    image: StampImage;
    /** 1-based page number. */
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface EditorRequest
{
    file: File;
    password?: string;
    printableOnly: boolean;
    placements: readonly Placement[];
    askPassword: (retry: boolean) => string | null;
}

type Corner = 'nw' | 'ne' | 'sw' | 'se';

const $ = <T extends HTMLElement>(id: string): T =>
{
    const el = document.getElementById(id);
    if (!el)
    {
        throw new Error(`Missing element #${id}`);
    }
    return el as T;
};

const dialog = $<HTMLDialogElement>('editor');
const title = $('editor-title');
const pageLabel = $('editor-page');
const prevButton = $<HTMLButtonElement>('editor-prev');
const nextButton = $<HTMLButtonElement>('editor-next');
const cancelButton = $<HTMLButtonElement>('editor-cancel');
const doneButton = $<HTMLButtonElement>('editor-done');
const stage = $('editor-stage');
const sheet = $('editor-sheet');
const imageInput = $<HTMLInputElement>('editor-file');
const libraryBox = $('editor-library');
const selectedBox = $('editor-selected');
const message = $('editor-message');

/** Images stay available for every document until the tab is closed. */
const library: StampImage[] = [];

interface Session
{
    pdf: OpenedPdf;
    renderer: PageRenderer;
    placements: Placement[];
    page: number;
    pageWidth: number;
    pageHeight: number;
    selected: Placement | null;
    /** Bumped on every page change so a slow render cannot land on the wrong page. */
    renderToken: number;
    finish: (result: Placement[] | null) => void;
}

let session: Session | null = null;

function el<K extends keyof HTMLElementTagNameMap> (tag: K, className = '', text = ''): HTMLElementTagNameMap[K]
{
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

/** Size of an image on the page, in points, when its pixels are read at `dpi`. */
function sizeAt (image: StampImage, dpi: number): { width: number; height: number }
{
    return {
        width: image.width / dpi * POINTS_PER_INCH,
        height: image.height / dpi * POINTS_PER_INCH,
    };
}

function formatMm (points: number): string
{
    const mm = points / POINTS_PER_INCH * MM_PER_INCH;
    return mm < 100 ? mm.toFixed(1) : mm.toFixed(0);
}

function describeSize (width: number, height: number): string
{
    const px = (points: number): number => Math.round(points / POINTS_PER_INCH * EDITOR_DPI);
    return `${px(width)} × ${px(height)} px at ${EDITOR_DPI} dpi · ${formatMm(width)} × ${formatMm(height)} mm`;
}

function hasOwnDpi (image: StampImage): boolean
{
    return image.dpi !== null && Math.abs(image.dpi - EDITOR_DPI) > 1;
}

function clampToPage (s: Session, p: Placement): void
{
    p.x = Math.min(Math.max(p.x, KEEP_ON_PAGE - p.width), s.pageWidth - KEEP_ON_PAGE);
    p.y = Math.min(Math.max(p.y, KEEP_ON_PAGE - p.height), s.pageHeight - KEEP_ON_PAGE);
}

/** Sets a placement's size around its current centre. */
function resizeAroundCentre (s: Session, p: Placement, width: number, height: number): void
{
    p.x += (p.width - width) / 2;
    p.y += (p.height - height) / 2;
    p.width = width;
    p.height = height;
    clampToPage(s, p);
}

function showMessage (text: string): void
{
    message.textContent = text;
    message.hidden = text === '';
}

async function loadImage (file: File): Promise<StampImage>
{
    const dpi = readImageDpi(new Uint8Array(await file.arrayBuffer()));
    const url = URL.createObjectURL(file);
    const element = new Image();
    element.draggable = false;
    element.src = url;
    try
    {
        await element.decode();
    }
    catch
    {
        URL.revokeObjectURL(url);
        throw new Error(`"${file.name}" is not an image this browser can open.`);
    }
    if (!element.naturalWidth || !element.naturalHeight)
    {
        URL.revokeObjectURL(url);
        throw new Error(`"${file.name}" has no pixel size.`);
    }
    return { name: file.name, url, element, width: element.naturalWidth, height: element.naturalHeight, dpi };
}

/** Puts an image on the current page at 300 dpi scale, in the middle of what is visible. */
function place (s: Session, image: StampImage): void
{
    let { width, height } = sizeAt(image, EDITOR_DPI);
    const fit = Math.min(1, s.pageWidth * 0.9 / width, s.pageHeight * 0.9 / height);
    width *= fit;
    height *= fit;

    const box = sheet.getBoundingClientRect();
    const view = stage.getBoundingClientRect();
    const scale = s.pageWidth / box.width;
    const centreX = (Math.min(box.right, view.right) + Math.max(box.left, view.left)) / 2 - box.left;
    const centreY = (Math.min(box.bottom, view.bottom) + Math.max(box.top, view.top)) / 2 - box.top;
    // Nudge repeated additions so they do not hide each other.
    const offset = s.placements.filter((p) => p.page === s.page).length % 6 * 10;

    const placement: Placement = {
        image,
        page: s.page,
        x: centreX * scale - width / 2 + offset,
        y: centreY * scale - height / 2 + offset,
        width,
        height,
    };
    clampToPage(s, placement);
    s.placements.push(placement);
    s.selected = placement;
    renderStamps(s);
    renderSide(s);
    // Arrow keys and Delete should work on the new image straight away.
    sheet.querySelector<HTMLElement>('.stamp.selected')?.focus({ preventScroll: true });
}

async function addImages (files: Iterable<File>): Promise<void>
{
    const s = session;
    // Wait for the first page: an image is sized against the page it lands on.
    if (!s || s.pageWidth <= 1)
    {
        return;
    }
    showMessage('');
    for (const file of files)
    {
        try
        {
            const image = await loadImage(file);
            library.push(image);
            if (session === s)
            {
                place(s, image);
            }
        }
        catch (error)
        {
            showMessage(error instanceof Error ? error.message : 'Could not add that image.');
        }
    }
}

function positionStamp (s: Session, node: HTMLElement, p: Placement): void
{
    node.style.left = `${p.x / s.pageWidth * 100}%`;
    node.style.top = `${p.y / s.pageHeight * 100}%`;
    node.style.width = `${p.width / s.pageWidth * 100}%`;
    node.style.height = `${p.height / s.pageHeight * 100}%`;
}

/** Follows the pointer until it is released, reporting movement in points. */
function track (
    s: Session,
    start: PointerEvent,
    onMove: (dx: number, dy: number) => void,
): void
{
    const target = start.currentTarget as HTMLElement;
    const scale = s.pageWidth / sheet.getBoundingClientRect().width;
    target.setPointerCapture(start.pointerId);

    const move = (event: PointerEvent): void =>
    {
        onMove((event.clientX - start.clientX) * scale, (event.clientY - start.clientY) * scale);
    };
    const stop = (): void =>
    {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', stop);
        target.removeEventListener('pointercancel', stop);
        renderSide(s);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
}

function select (s: Session, p: Placement | null): void
{
    if (s.selected !== p)
    {
        s.selected = p;
        renderStamps(s);
        renderSide(s);
    }
}

function remove (s: Session, p: Placement): void
{
    s.placements.splice(s.placements.indexOf(p), 1);
    if (s.selected === p)
    {
        s.selected = null;
    }
    renderStamps(s);
    renderSide(s);
}

function renderStamps (s: Session): void
{
    for (const old of sheet.querySelectorAll('.stamp'))
    {
        old.remove();
    }
    for (const p of s.placements)
    {
        if (p.page !== s.page)
        {
            continue;
        }
        const node = el('div', p === s.selected ? 'stamp selected' : 'stamp');
        node.tabIndex = 0;
        node.setAttribute('role', 'img');
        node.setAttribute('aria-label', `${p.image.name}, placed image. Arrow keys move it, Delete removes it.`);
        const img = el('img');
        img.src = p.image.url;
        img.alt = '';
        img.draggable = false;
        node.append(img);
        positionStamp(s, node, p);

        node.addEventListener('pointerdown', (event) =>
        {
            if (event.button !== 0)
            {
                return;
            }
            event.preventDefault();
            markSelected(s, node, p);
            node.focus({ preventScroll: true });
            const startX = p.x;
            const startY = p.y;
            track(s, event, (dx, dy) =>
            {
                p.x = startX + dx;
                p.y = startY + dy;
                clampToPage(s, p);
                positionStamp(s, node, p);
            });
        });

        node.addEventListener('keydown', (event) =>
        {
            const step = (event.shiftKey ? 10 : 1) * POINTS_PER_INCH / EDITOR_DPI;
            const moves: Record<string, [number, number]> = {
                ArrowLeft: [-step, 0],
                ArrowRight: [step, 0],
                ArrowUp: [0, -step],
                ArrowDown: [0, step],
            };
            const delta = moves[event.key];
            if (delta)
            {
                event.preventDefault();
                p.x += delta[0];
                p.y += delta[1];
                clampToPage(s, p);
                positionStamp(s, node, p);
            }
            else if (event.key === 'Delete' || event.key === 'Backspace')
            {
                event.preventDefault();
                remove(s, p);
            }
        });
        node.addEventListener('focus', () => markSelected(s, node, p));

        if (p === s.selected)
        {
            addHandles(s, node, p);
        }
        sheet.append(node);
    }
}

/**
 * Selects a placement whose node is already on the sheet. Rebuilding the nodes
 * here would drop the one being pressed or focused, so restyle in place.
 */
function markSelected (s: Session, node: HTMLElement, p: Placement): void
{
    if (s.selected === p)
    {
        return;
    }
    s.selected = p;
    sheet.querySelector('.stamp.selected')?.classList.remove('selected');
    for (const handle of sheet.querySelectorAll('.stamp-handle'))
    {
        handle.remove();
    }
    node.classList.add('selected');
    addHandles(s, node, p);
    renderSide(s);
}

function addHandles (s: Session, node: HTMLElement, p: Placement): void
{
    for (const corner of ['nw', 'ne', 'sw', 'se'] as Corner[])
    {
        const handle = el('span', `stamp-handle ${corner}`);
        handle.addEventListener('pointerdown', (event) =>
        {
            if (event.button !== 0)
            {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const start = { ...p };
            const ratio = start.height / start.width;
            const west = corner === 'nw' || corner === 'sw';
            const north = corner === 'nw' || corner === 'ne';
            track(s, event, (dx) =>
            {
                // The opposite corner stays put; the aspect ratio is kept.
                const width = Math.max(MIN_SIZE, start.width + (west ? -dx : dx));
                const height = width * ratio;
                p.width = width;
                p.height = height;
                p.x = west ? start.x + start.width - width : start.x;
                p.y = north ? start.y + start.height - height : start.y;
                positionStamp(s, node, p);
            });
        });
        node.append(handle);
    }
}

function renderLibrary (s: Session): void
{
    libraryBox.replaceChildren();
    libraryBox.hidden = library.length === 0;
    for (const image of library)
    {
        const button = el('button', 'library-item');
        button.type = 'button';
        button.title = `Place ${image.name} on this page`;
        const img = el('img');
        img.src = image.url;
        img.alt = image.name;
        button.append(img);
        button.addEventListener('click', () => place(s, image));
        libraryBox.append(button);
    }
}

function renderSelected (s: Session): void
{
    const p = s.selected;
    selectedBox.replaceChildren();
    selectedBox.hidden = !p;
    if (!p)
    {
        return;
    }
    const { image } = p;
    const heading = el('strong', 'selected-name', image.name);
    heading.title = image.name;
    selectedBox.append(heading, el('p', 'selected-size', describeSize(p.width, p.height)));

    const matches = (size: { width: number }): boolean => Math.abs(size.width - p.width) < 0.05;
    const at300 = sizeAt(image, EDITOR_DPI);

    if (hasOwnDpi(image) && image.dpi !== null)
    {
        const own = sizeAt(image, image.dpi);
        selectedBox.append(el(
            'p',
            'hint',
            `This file says it is ${image.dpi} dpi, not ${EDITOR_DPI}. Choose how big it should be:`,
        ));
        const choices = el('div', 'size-choices');
        const choice = (label: string, size: { width: number; height: number }): void =>
        {
            const button = el('button', 'ghost size-choice');
            button.type = 'button';
            button.setAttribute('aria-pressed', String(matches(size)));
            button.append(el('b', '', label), el('small', '', `${formatMm(size.width)} × ${formatMm(size.height)} mm`));
            button.addEventListener('click', () =>
            {
                resizeAroundCentre(s, p, size.width, size.height);
                renderStamps(s);
                renderSide(s);
            });
            choices.append(button);
        };
        choice(`As ${EDITOR_DPI} dpi (pixel for pixel)`, at300);
        choice(`Its own ${image.dpi} dpi`, own);
        selectedBox.append(choices);
    }
    else
    {
        selectedBox.append(el(
            'p',
            'hint',
            image.dpi === null
                ? `The file stores no resolution, so its pixels are placed at ${EDITOR_DPI} dpi.`
                : `The file is ${EDITOR_DPI} dpi.`,
        ));
        if (!matches(at300))
        {
            const reset = el('button', 'ghost', `Reset to ${EDITOR_DPI} dpi size`);
            reset.type = 'button';
            reset.addEventListener('click', () =>
            {
                resizeAroundCentre(s, p, at300.width, at300.height);
                renderStamps(s);
                renderSide(s);
            });
            selectedBox.append(reset);
        }
    }

    const actions = el('div', 'selected-actions');
    if (s.pdf.doc.numPages > 1)
    {
        const copy = el('button', 'ghost', 'Copy to all pages');
        copy.type = 'button';
        copy.addEventListener('click', () =>
        {
            for (let page = 1; page <= s.pdf.doc.numPages; page++)
            {
                const exists = s.placements.some((other) => other.page === page
                    && other.image === p.image
                    && Math.abs(other.x - p.x) < 0.5
                    && Math.abs(other.y - p.y) < 0.5);
                if (!exists)
                {
                    s.placements.push({ ...p, page });
                }
            }
            renderSide(s);
        });
        actions.append(copy);
    }
    const removeButton = el('button', 'ghost', 'Remove');
    removeButton.type = 'button';
    removeButton.addEventListener('click', () => remove(s, p));
    actions.append(removeButton);
    selectedBox.append(actions);
}

function renderSide (s: Session): void
{
    renderLibrary(s);
    renderSelected(s);
    const total = s.pdf.doc.numPages;
    const here = s.placements.filter((p) => p.page === s.page).length;
    const all = s.placements.length;
    pageLabel.textContent = `Page ${s.page} of ${total}`
        + (all ? ` · ${here} here, ${all} in document` : '');
    prevButton.disabled = s.page <= 1;
    nextButton.disabled = s.page >= total;
}

async function showPage (s: Session, number: number): Promise<void>
{
    const token = ++s.renderToken;
    s.page = number;
    s.selected = null;
    renderSide(s);

    const page = await s.pdf.doc.getPage(number);
    if (session !== s || token !== s.renderToken)
    {
        return;
    }
    const size = page.getViewport({ scale: 1 });
    s.pageWidth = size.width;
    s.pageHeight = size.height;
    sheet.style.aspectRatio = `${size.width} / ${size.height}`;
    renderStamps(s);

    // Sharp enough for the screen, without rendering a full 300 dpi bitmap.
    const shown = sheet.getBoundingClientRect().width || 800;
    const pixels = Math.min(2400, Math.max(600, shown * Math.min(2, window.devicePixelRatio || 1)));
    const viewport = page.getViewport({ scale: pixels / size.width });
    const canvas = el('canvas', 'editor-canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx)
    {
        return;
    }
    try
    {
        await s.renderer.render(page, ctx, viewport);
    }
    finally
    {
        page.cleanup();
    }
    if (session === s && token === s.renderToken)
    {
        sheet.querySelector('canvas')?.remove();
        sheet.prepend(canvas);
    }
}

function close (result: Placement[] | null): void
{
    const s = session;
    if (!s)
    {
        return;
    }
    session = null;
    sheet.replaceChildren();
    showMessage('');
    if (dialog.open)
    {
        dialog.close();
    }
    void s.pdf.close();
    s.finish(result);
}

/**
 * Opens the editor for one document. Resolves with the new list of placements
 * when the user presses Done, or null when they cancel.
 */
export async function openEditor (request: EditorRequest): Promise<Placement[] | null>
{
    if (session)
    {
        return null;
    }
    const pdf = await openPdf(await request.file.arrayBuffer(), request.password, request.askPassword);

    return new Promise((resolve) =>
    {
        const s: Session = {
            pdf,
            renderer: new PageRenderer(pdf.doc, request.printableOnly),
            placements: request.placements.map((p) => ({ ...p })),
            page: 1,
            pageWidth: 1,
            pageHeight: 1,
            selected: null,
            renderToken: 0,
            finish: resolve,
        };
        session = s;
        title.textContent = request.file.name;
        title.title = request.file.name;
        dialog.showModal();
        void showPage(s, 1);
    });
}

/** Hands dropped or pasted files to the editor. Returns false when it is closed. */
export function offerImagesToEditor (files: readonly File[]): boolean
{
    if (!session)
    {
        return false;
    }
    void addImages(files.filter((file) => file.type.startsWith('image/')));
    return true;
}

imageInput.addEventListener('change', () =>
{
    void addImages(Array.from(imageInput.files ?? []));
    imageInput.value = '';
});
prevButton.addEventListener('click', () => session && void showPage(session, session.page - 1));
nextButton.addEventListener('click', () => session && void showPage(session, session.page + 1));
doneButton.addEventListener('click', () => close(session ? session.placements : null));
cancelButton.addEventListener('click', () => close(null));
// Escape closes a modal dialog on its own; treat it as Cancel.
dialog.addEventListener('close', () => close(null));
// A press on the page itself, not on an image, clears the selection.
sheet.addEventListener('pointerdown', (event) =>
{
    if (session && !(event.target as HTMLElement).closest('.stamp'))
    {
        select(session, null);
    }
});
document.addEventListener('paste', (event) =>
{
    const files = Array.from(event.clipboardData?.files ?? []);
    if (session && files.length)
    {
        event.preventDefault();
        offerImagesToEditor(files);
    }
});
