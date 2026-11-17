import { zipSync } from 'fflate';
import { CancelledError, flatten, PasswordError, type FlattenOptions } from './flatten';

/** Resolution presets, in dots per inch. */
const PRESETS: Record<string, number> = {
    small: 100,
    balanced: 150,
    sharp: 220,
    print: 300,
};

type Status = 'pending' | 'working' | 'done' | 'error';

interface Item
{
    file: File;
    outName: string;
    status: Status;
    /** Bumped whenever the item is re-queued or removed, to stop a running job. */
    run: number;
    done: number;
    total: number;
    result: Blob | null;
    url: string | null;
    /** Object URL of the flattened first page, shown as a thumbnail. */
    preview: string | null;
    error: string;
    el: HTMLLIElement;
}

const $ = <T extends HTMLElement>(selector: string): T =>
{
    const el = document.querySelector<T>(selector);
    if (!el)
    {
        throw new Error(`Missing element ${selector}`);
    }
    return el;
};

const drop = $<HTMLLabelElement>('#drop');
const fileInput = $<HTMLInputElement>('#file');
const grayInput = $<HTMLInputElement>('#gray');
const printableInput = $<HTMLInputElement>('#printable');
const qualityInput = $<HTMLInputElement>('#quality');
const qualityValue = $<HTMLOutputElement>('#quality-value');
const results = $<HTMLElement>('#results');
const list = $<HTMLUListElement>('#list');
const clearButton = $<HTMLButtonElement>('#clear');
const downloadAllButton = $<HTMLButtonElement>('#download-all');

const items: Item[] = [];
let busy = false;

function currentOptions (): FlattenOptions
{
    const checked = document.querySelector<HTMLInputElement>('input[name="preset"]:checked');
    const ocr = document.querySelector<HTMLInputElement>('input[name="ocr"]:checked')?.value;
    return {
        dpi: PRESETS[checked?.value ?? 'small'] ?? PRESETS.small,
        quality: Number(qualityInput.value) / 100,
        grayscale: grayInput.checked,
        printableOnly: printableInput.checked,
        ocrProtection: ocr === 'light' || ocr === 'strong' ? ocr : 'off',
    };
}

function formatSize (bytes: number): string
{
    if (bytes < 1024)
    {
        return `${bytes} B`;
    }
    const kb = bytes / 1024;
    if (kb < 1024)
    {
        return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
    }
    const mb = kb / 1024;
    return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
}

function isPdf (file: File): boolean
{
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/** "report.pdf" -> "report-flat.pdf", made unique among the current items. */
function outputName (name: string): string
{
    const base = name.replace(/\.pdf$/i, '');
    const taken = new Set(items.map((item) => item.outName));
    let candidate = `${base}-flat.pdf`;
    for (let i = 2; taken.has(candidate); i++)
    {
        candidate = `${base}-flat-${i}.pdf`;
    }
    return candidate;
}

function el<K extends keyof HTMLElementTagNameMap> (
    tag: K,
    className = '',
    text = '',
): HTMLElementTagNameMap[K]
{
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

function releaseResult (item: Item): void
{
    if (item.url)
    {
        URL.revokeObjectURL(item.url);
    }
    item.url = null;
    item.result = null;
}

function setPreview (item: Item, jpeg: Blob | null): void
{
    if (item.preview)
    {
        URL.revokeObjectURL(item.preview);
    }
    item.preview = jpeg ? URL.createObjectURL(jpeg) : null;
}

function renderItem (item: Item): void
{
    const { el: row } = item;
    row.className = `item ${item.status}`;
    row.replaceChildren();

    const thumb = el('a', 'item-thumb');
    if (item.preview)
    {
        const img = el('img');
        img.src = item.preview;
        img.alt = `First page of ${item.file.name}`;
        thumb.href = item.preview;
        thumb.target = '_blank';
        thumb.title = 'Open first page preview';
        thumb.append(img);
    }

    const name = el('div', 'item-name', item.file.name);
    name.title = item.file.name;

    const status = el('div', 'item-status');
    const actions = el('div', 'item-actions');

    switch (item.status)
    {
        case 'pending':
            status.textContent = `${formatSize(item.file.size)} · waiting`;
            break;
        case 'working':
            status.textContent = item.total
                ? `Flattening page ${Math.min(item.done + 1, item.total)} of ${item.total}`
                : 'Reading…';
            break;
        case 'done':
        {
            const out = item.result?.size ?? 0;
            const change = item.file.size
                ? Math.round((out / item.file.size - 1) * 100)
                : 0;
            const pages = `${item.total} ${item.total === 1 ? 'page' : 'pages'}`;
            status.append(
                el('b', '', 'Done'),
                ` · ${pages} · ${formatSize(item.file.size)} → ${formatSize(out)}`
                + ` (${change > 0 ? '+' : ''}${change}%)`,
            );
            const link = el('a', 'button', 'Download');
            link.href = item.url ?? '#';
            link.download = item.outName;
            actions.append(link);
            break;
        }
        case 'error':
            status.textContent = item.error;
            break;
    }

    const remove = el('button', 'icon', '✕');
    remove.type = 'button';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', `Remove ${item.file.name}`);
    remove.addEventListener('click', () => removeItem(item));
    actions.append(remove);

    row.append(thumb, name, status, actions);

    if (item.status === 'working')
    {
        const bar = el('progress');
        if (item.total)
        {
            bar.max = item.total;
            bar.value = item.done;
        }
        row.append(bar);
    }
}

function renderSummary (): void
{
    results.hidden = items.length === 0;
    const ready = items.filter((item) => item.status === 'done').length;
    downloadAllButton.hidden = ready < 2;
}

function removeItem (item: Item): void
{
    const index = items.indexOf(item);
    if (index < 0)
    {
        return;
    }
    items.splice(index, 1);
    item.run++;
    releaseResult(item);
    setPreview(item, null);
    item.el.remove();
    renderSummary();
}

function describeError (error: unknown): string
{
    if (error instanceof PasswordError)
    {
        return 'Password protected. Add the file again to enter the password.';
    }
    if (error instanceof Error && error.name === 'InvalidPDFException')
    {
        return 'This file is not a valid PDF or is damaged.';
    }
    if (error instanceof Error && error.message)
    {
        return `Could not flatten: ${error.message}`;
    }
    return 'Could not flatten this file.';
}

async function processItem (item: Item): Promise<void>
{
    const run = item.run;
    const stale = (): boolean => item.run !== run;

    item.status = 'working';
    item.done = 0;
    item.total = 0;
    renderItem(item);

    try
    {
        const bytes = await flatten(await item.file.arrayBuffer(), currentOptions(), {
            isCancelled: stale,
            onProgress: (done, total) =>
            {
                if (!stale())
                {
                    item.done = done;
                    item.total = total;
                    renderItem(item);
                }
            },
            onPreview: (jpeg) =>
            {
                if (!stale())
                {
                    setPreview(item, jpeg);
                    renderItem(item);
                }
            },
            askPassword: (retry) => window.prompt(
                retry
                    ? `Wrong password. Enter the password for "${item.file.name}":`
                    : `"${item.file.name}" is password protected. Enter its password:`,
            ),
        });
        if (stale())
        {
            return;
        }
        item.result = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
        item.url = URL.createObjectURL(item.result);
        item.status = 'done';
    }
    catch (error)
    {
        if (stale() || error instanceof CancelledError)
        {
            return;
        }
        console.error(error);
        item.status = 'error';
        item.error = describeError(error);
    }
    renderItem(item);
}

/** Files are flattened one at a time to keep memory use bounded. */
async function pump (): Promise<void>
{
    if (busy)
    {
        return;
    }
    busy = true;
    try
    {
        for (;;)
        {
            const next = items.find((item) => item.status === 'pending');
            if (!next)
            {
                break;
            }
            await processItem(next);
            renderSummary();
        }
    }
    finally
    {
        busy = false;
    }
}

function addFiles (files: Iterable<File>): void
{
    for (const file of files)
    {
        const item: Item = {
            file,
            outName: outputName(file.name),
            status: 'pending',
            run: 0,
            done: 0,
            total: 0,
            result: null,
            url: null,
            preview: null,
            error: '',
            el: el('li'),
        };
        if (!isPdf(file))
        {
            item.status = 'error';
            item.error = 'Not a PDF file.';
        }
        items.push(item);
        list.append(item.el);
        renderItem(item);
    }
    renderSummary();
    void pump();
}

/** A new quality setting applies to everything in the list, so redo it all. */
function requeueAll (): void
{
    for (const item of items)
    {
        if (!isPdf(item.file))
        {
            continue;
        }
        item.run++;
        releaseResult(item);
        item.status = 'pending';
        renderItem(item);
    }
    renderSummary();
    void pump();
}

function save (blob: Blob, name: string): void
{
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function downloadAll (): Promise<void>
{
    downloadAllButton.disabled = true;
    try
    {
        const entries: Record<string, Uint8Array> = {};
        for (const item of items)
        {
            if (item.status === 'done' && item.result)
            {
                entries[item.outName] = new Uint8Array(await item.result.arrayBuffer());
            }
        }
        // JPEG pages do not compress further, so just store them.
        const zip = zipSync(entries, { level: 0 });
        save(new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), 'flatpdf.zip');
    }
    finally
    {
        downloadAllButton.disabled = false;
    }
}

fileInput.addEventListener('change', () =>
{
    addFiles(Array.from(fileInput.files ?? []));
    fileInput.value = '';
});

// Accept a drop anywhere on the page, not only on the drop zone, so a near
// miss does not make the browser navigate away to the PDF.
let dragDepth = 0;
const hasFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');

window.addEventListener('dragenter', (event) =>
{
    if (hasFiles(event))
    {
        event.preventDefault();
        dragDepth++;
        drop.classList.add('over');
    }
});
window.addEventListener('dragover', (event) =>
{
    if (hasFiles(event))
    {
        event.preventDefault();
        if (event.dataTransfer)
        {
            event.dataTransfer.dropEffect = 'copy';
        }
    }
});
window.addEventListener('dragleave', () =>
{
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0)
    {
        drop.classList.remove('over');
    }
});
window.addEventListener('drop', (event) =>
{
    if (!hasFiles(event))
    {
        return;
    }
    event.preventDefault();
    dragDepth = 0;
    drop.classList.remove('over');
    addFiles(Array.from(event.dataTransfer?.files ?? []));
});

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="preset"], input[name="ocr"]'))
{
    input.addEventListener('change', requeueAll);
}
grayInput.addEventListener('change', requeueAll);
printableInput.addEventListener('change', requeueAll);
qualityInput.addEventListener('input', () =>
{
    qualityValue.value = qualityInput.value;
});
// 'change' fires once the slider is released, so dragging does not restart work.
qualityInput.addEventListener('change', requeueAll);
qualityValue.value = qualityInput.value;

clearButton.addEventListener('click', () =>
{
    for (const item of [...items])
    {
        removeItem(item);
    }
});
downloadAllButton.addEventListener('click', () => void downloadAll());
