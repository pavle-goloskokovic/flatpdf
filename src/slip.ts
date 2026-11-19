import { addToLibrary } from './editor';
import { PasswordError } from './flatten';
import { buildIps, EXTRA_LABELS, KINDS, parseIps, toValues, type IpsCode, type SlipValues } from './ips';
import { drawQr, makeQr, modulesOf } from './qr-make';
import { scanImage, scanPdf, type ScannedQr } from './qr-read';

/** The largest version the National Bank of Serbia allows for an IPS code. */
const MAX_IPS_VERSION = 13;
const MAX_CELL = 40;

const $ = <T extends HTMLElement>(id: string): T =>
{
    const el = document.getElementById(id);
    if (!el)
    {
        throw new Error(`Missing element #${id}`);
    }
    return el as T;
};

const dialog = $<HTMLDialogElement>('slip');
const popup = $<HTMLDialogElement>('qr-popup');
const form = $<HTMLFormElement>('slip-form');
const pageInput = $<HTMLInputElement>('qr-file');
const dialogInput = $<HTMLInputElement>('slip-file');
const pageStatus = $('qr-status');
const message = $('slip-message');
const closeButton = $<HTMLButtonElement>('slip-close');
const extraBox = $('slip-extra');
const kindSelect = $<HTMLSelectElement>('slip-kind');
const originalBox = $('slip-original');
const originalInfo = $('slip-original-info');
const newBox = $('slip-new');
const newInfo = $('slip-new-info');
const cellInput = $<HTMLInputElement>('slip-cell');
const warningList = $('slip-warnings');
const downloadButton = $<HTMLButtonElement>('slip-download');
const copyButton = $<HTMLButtonElement>('slip-copy');
const trayButton = $<HTMLButtonElement>('slip-tray');
const resetButton = $<HTMLButtonElement>('slip-reset');
const textBox = $('slip-text');

type TextKey = 'payer' | 'purpose' | 'payee' | 'code' | 'currency' | 'amount' | 'account' | 'model' | 'reference';

const inputs: Record<TextKey, HTMLInputElement | HTMLTextAreaElement> = {
    payer: $<HTMLTextAreaElement>('slip-payer'),
    purpose: $<HTMLTextAreaElement>('slip-purpose'),
    payee: $<HTMLTextAreaElement>('slip-payee'),
    code: $<HTMLInputElement>('slip-code'),
    currency: $<HTMLInputElement>('slip-currency'),
    amount: $<HTMLInputElement>('slip-amount'),
    account: $<HTMLInputElement>('slip-account'),
    model: $<HTMLInputElement>('slip-model'),
    reference: $<HTMLInputElement>('slip-reference'),
};

interface Session
{
    source: ScannedQr;
    code: IpsCode;
    initial: SlipValues;
    extraInputs: Map<string, HTMLInputElement | HTMLTextAreaElement>;
    /** The new code as last drawn, or null when the data does not fit any QR code. */
    canvas: HTMLCanvasElement | null;
}

let session: Session | null = null;
let reading = false;

function el<K extends keyof HTMLElementTagNameMap> (tag: K, className = '', text = ''): HTMLElementTagNameMap[K]
{
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

/** Shown on the page, or in the dialog when that is what the user is looking at. */
function showStatus (text: string, isError = false): void
{
    for (const node of [pageStatus, message])
    {
        node.textContent = text;
        node.hidden = text === '';
        node.classList.toggle('error', isError);
    }
}

function describe (version: number, ecLevel: string, cell: string, bytes: number): string
{
    const modules = modulesOf(version);
    return `Version ${version} (${modules} × ${modules} modules) · error correction ${ecLevel}`
        + ` · ${cell} px per module · ${bytes} bytes`;
}

function readForm (s: Session): SlipValues
{
    const extra: Record<string, string> = {};
    for (const [tag, input] of s.extraInputs)
    {
        extra[tag] = input.value;
    }
    return {
        kind: kindSelect.value,
        payer: inputs.payer.value,
        purpose: inputs.purpose.value,
        payee: inputs.payee.value,
        code: inputs.code.value,
        currency: inputs.currency.value,
        amount: inputs.amount.value,
        account: inputs.account.value,
        model: inputs.model.value,
        reference: inputs.reference.value,
        extra,
    };
}

function fillForm (s: Session): void
{
    const values = s.initial;
    for (const key of Object.keys(inputs) as TextKey[])
    {
        inputs[key].value = values[key];
    }

    kindSelect.replaceChildren();
    for (const kind of values.kind in KINDS ? Object.keys(KINDS) : [values.kind, ...Object.keys(KINDS)])
    {
        const option = el('option', '', KINDS[kind] ?? kind);
        option.value = kind;
        kindSelect.append(option);
    }
    kindSelect.value = values.kind;

    extraBox.replaceChildren();
    s.extraInputs.clear();
    for (const tag of Object.keys(values.extra))
    {
        const label = el('label', 'slip-extra-field', EXTRA_LABELS[tag] ?? `Field ${tag}`);
        const multiline = values.extra[tag].includes('\n');
        const input = multiline ? el('textarea') : el('input');
        if (multiline && input instanceof HTMLTextAreaElement)
        {
            input.rows = 3;
        }
        input.value = values.extra[tag];
        input.spellcheck = false;
        label.append(input);
        extraBox.append(label);
        s.extraInputs.set(tag, input);
    }
}

function render (s: Session): void
{
    const { source } = s;
    const { text, warnings } = buildIps(s.code, s.initial, readForm(s));
    const changed = text !== source.text;
    const bytes = new TextEncoder().encode(text);
    const cell = Math.min(MAX_CELL, Math.max(1, Math.round(Number(cellInput.value)) || 1));
    const qr = makeQr(bytes, source.version, source.ecLevel);
    const notes = [...warnings];

    newBox.replaceChildren();
    s.canvas = null;
    if (qr)
    {
        s.canvas = drawQr(qr, cell);
        s.canvas.className = 'qr-image';
        s.canvas.setAttribute('role', 'img');
        s.canvas.setAttribute('aria-label', 'New QR code');
        newBox.append(s.canvas);
        const side = s.canvas.width;
        newInfo.textContent = `${describe(qr.version, source.ecLevel, String(cell), bytes.length)}`
            + ` · ${side} × ${side} px with the white border`;
        if (qr.version > source.version)
        {
            notes.unshift(
                `The new data does not fit version ${source.version} at error correction ${source.ecLevel}, `
                + `so the code grew to version ${qr.version} (${qr.modules} × ${qr.modules} modules). `
                + 'Shorten a name or the purpose to get the original size back.',
            );
        }
        if (qr.version > MAX_IPS_VERSION)
        {
            notes.unshift(`NBS IPS codes may be version ${MAX_IPS_VERSION} at most; banking apps may refuse this one.`);
        }
    }
    else
    {
        newInfo.textContent = '';
        notes.unshift('This is more data than any QR code can hold.');
    }

    warningList.replaceChildren(...notes.map((note) => el('li', '', note)));
    warningList.hidden = notes.length === 0;
    textBox.textContent = text;
    $('slip-new-title').textContent = changed ? 'New code' : 'New code (nothing changed yet)';
    resetButton.disabled = !changed;
    for (const button of [downloadButton, copyButton, trayButton])
    {
        button.disabled = !s.canvas;
    }
}

function open (source: ScannedQr, code: IpsCode): void
{
    const s: Session = { source, code, initial: toValues(code), extraInputs: new Map(), canvas: null };
    session = s;

    source.crop.className = 'qr-image';
    source.crop.setAttribute('role', 'img');
    source.crop.setAttribute('aria-label', 'Original QR code');
    originalBox.replaceChildren(source.crop);
    originalInfo.textContent = describe(
        source.version,
        source.ecLevel,
        source.moduleSize.toFixed(source.moduleSize < 10 ? 1 : 0),
        source.bytes.length,
    ) + (source.page ? ` · page ${source.page} at 300 dpi` : '');

    // Whole pixels keep the modules sharp; a code smaller than that is not worth copying.
    cellInput.value = String(Math.min(MAX_CELL, Math.max(1, Math.round(source.moduleSize))));
    fillForm(s);
    render(s);
    if (popup.open)
    {
        popup.close();
    }
    if (!dialog.open)
    {
        dialog.showModal();
    }
    inputs.amount.focus();
    inputs.amount.select();
}

function close (): void
{
    session = null;
    showStatus('');
    if (dialog.open)
    {
        dialog.close();
    }
}

function isPdf (file: File): boolean
{
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/** Reads the QR code in an image or PDF and opens the payment slip for it. */
export async function readQrFile (file: File): Promise<void>
{
    if (reading)
    {
        return;
    }
    reading = true;
    showStatus(`Reading ${file.name}…`);
    try
    {
        const isIps = (qr: ScannedQr): boolean => parseIps(qr.text) !== null;
        const found = isPdf(file)
            ? await scanPdf(
                await file.arrayBuffer(),
                (retry) => window.prompt(retry
                    ? `Wrong password. Enter the password for "${file.name}":`
                    : `"${file.name}" is password protected. Enter its password:`),
                isIps,
            )
            : await scanImage(file);

        const source = found.find(isIps);
        const code = source ? parseIps(source.text) : null;
        if (!source || !code)
        {
            const other = found[0]?.text.replace(/\s+/g, ' ').slice(0, 80);
            showStatus(
                other === undefined
                    ? `No QR code found in ${file.name}. A sharper or larger picture of the code may help.`
                    : `The QR code in ${file.name} is not an NBS IPS code. It says: ${other}`,
                true,
            );
            return;
        }
        showStatus('');
        open(source, code);
    }
    catch (error)
    {
        console.error(error);
        showStatus(
            error instanceof PasswordError
                ? `${file.name} is password protected.`
                : `Could not read ${file.name}: ${error instanceof Error && error.message ? error.message : 'unknown error'}`,
            true,
        );
    }
    finally
    {
        reading = false;
    }
}

/** Hands dropped files to the popup or the slip while one is open. Returns false when both are closed. */
export function offerFilesToSlip (files: readonly File[]): boolean
{
    if (!dialog.open && !popup.open)
    {
        return false;
    }
    const file = files.find((f) => f.type.startsWith('image/') || isPdf(f));
    if (file)
    {
        void readQrFile(file);
    }
    return true;
}

function toPng (canvas: HTMLCanvasElement): Promise<Blob>
{
    return new Promise((resolve, reject) =>
    {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))), 'image/png');
    });
}

/** Briefly swaps a button's label to confirm what it did. */
function confirmOn (button: HTMLButtonElement, text: string): void
{
    const label = button.dataset.label ?? button.textContent ?? '';
    button.dataset.label = label;
    button.textContent = text;
    setTimeout(() =>
    {
        button.textContent = label;
    }, 2000);
}

async function withImage (button: HTMLButtonElement, done: string, use: (png: Blob) => Promise<void> | void): Promise<void>
{
    const canvas = session?.canvas;
    if (!canvas)
    {
        return;
    }
    try
    {
        await use(await toPng(canvas));
        showStatus('');
        confirmOn(button, done);
    }
    catch (error)
    {
        console.error(error);
        showStatus(error instanceof Error && error.message ? error.message : 'That did not work.', true);
    }
}

for (const input of [pageInput, dialogInput])
{
    input.addEventListener('change', () =>
    {
        const file = input.files?.[0];
        input.value = '';
        if (file)
        {
            void readQrFile(file);
        }
    });
}

form.addEventListener('submit', (event) => event.preventDefault());
for (const node of [form, cellInput])
{
    node.addEventListener('input', () => session && render(session));
}

resetButton.addEventListener('click', () =>
{
    if (session)
    {
        fillForm(session);
        render(session);
    }
});
downloadButton.addEventListener('click', () => void withImage(downloadButton, 'Saved', (png) =>
{
    const url = URL.createObjectURL(png);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ips-qr.png';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}));
copyButton.addEventListener('click', () => void withImage(copyButton, 'Copied', async (png) =>
{
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}));
trayButton.addEventListener('click', () => void withImage(trayButton, 'Added', async (png) =>
{
    await addToLibrary(new File([png], 'ips-qr.png', { type: 'image/png' }));
}));

closeButton.addEventListener('click', close);
// Escape closes a modal dialog on its own.
dialog.addEventListener('close', close);

document.addEventListener('paste', (event) =>
{
    if (!dialog.open && !popup.open)
    {
        return;
    }
    const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
    if (file)
    {
        event.preventDefault();
        void readQrFile(file);
    }
});

// This module arrives after the popup is already showing its loading note.
showStatus('');
