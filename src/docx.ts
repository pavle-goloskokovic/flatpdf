import { parseAsync, renderDocument } from 'docx-preview';
import { strFromU8, unzipSync } from 'fflate';
import { UnsupportedFileError, type SourceDocument, type SourcePage } from './source';

// docx-preview creates its nodes in this window and they are then moved into a
// hidden frame. Such a node can show up as an object of either window, so
// nothing here may test one with `instanceof`.

/** docx-preview's class prefix; its style rules are all scoped to it. */
const CLASS = 'docx';
const CSS_PX_PER_POINT = 96 / 72;
/**
 * A page that comes out up to this much taller than its paper is scaled down to
 * fit instead of spilling a few lines onto a page of their own. The browser
 * never breaks lines exactly like Word, so a page Word filled often runs over.
 */
const SQUEEZE_LIMIT = 1.1;
/** docx-preview sets tab stops on a timer this long after it rendered. */
const TAB_STOP_DELAY = 500;

/** Class prefix marking the two halves of a paragraph that runs over a page start. */
const SPLIT = 'flat-split-';
/** Class of the second half: the rest of a paragraph, not a new one. */
const CONTINUED = 'flat-continued';
/** Custom property holding a paragraph's natural line height as a multiple of its font size. */
const LINE = '--flat-line';

/**
 * Undoes the on-screen preview dressing (grey backdrop, gaps, shadows) around
 * the pages, lets a footer sit at the bottom of its space like Word does, and
 * keeps the rest of a split paragraph from looking like the start of one: no
 * first-line indent and no list number of its own.
 */
const PAGE_CSS = `
html, body { margin: 0; padding: 0; }
.${CLASS}-wrapper { background: none !important; padding: 0 !important; display: block !important; }
.${CLASS}-wrapper > section.${CLASS} { box-shadow: none !important; margin: 0 !important; }
.${CLASS}-wrapper > section.${CLASS} > footer { display: flex; flex-direction: column; justify-content: flex-end; }
p.${CONTINUED} { text-indent: 0 !important; list-style-type: none !important; }
p.${CONTINUED}::before { content: none !important; counter-increment: none !important; }
`;

/** A horizontal strip of a rendered section and where on the page it goes, in CSS pixels. */
interface Part
{
    sourceY: number;
    height: number;
    pageY: number;
}

interface PagePlan
{
    /** Index of the section element the page is cut from. */
    section: number;
    /** Page size in CSS pixels. */
    width: number;
    height: number;
    /** Scale applied to the section to make it fit the page; 1 unless squeezed. */
    fit: number;
    parts: Part[];
}

/**
 * Vertical extents, relative to `originY`, of the things a page cut must not
 * go through: lines of text and pictures. Sorted and merged.
 */
function solidRanges (section: HTMLElement, originY: number): Array<[number, number]>
{
    const doc = section.ownerDocument;
    const range = doc.createRange();
    const found: Array<[number, number]> = [];
    const walker = doc.createTreeWalker(section, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
    {
        if (node.nodeType === Node.TEXT_NODE)
        {
            if (!/\S/.test(node.nodeValue ?? ''))
            {
                continue;
            }
            range.selectNodeContents(node);
            for (const rect of range.getClientRects())
            {
                // A line's box is as tall as the font, which can be taller than
                // the line spacing. Keep its core so tight lines stay apart.
                const inset = rect.height * 0.2;
                found.push([rect.top - originY + inset, rect.bottom - originY - inset]);
            }
        }
        else if (/^(img|svg|canvas)$/i.test(node.nodeName))
        {
            const rect = (node as Element).getBoundingClientRect();
            found.push([rect.top - originY, rect.bottom - originY]);
        }
    }
    found.sort((a, b) => a[0] - b[0]);

    const merged: Array<[number, number]> = [];
    for (const [top, bottom] of found)
    {
        const last = merged[merged.length - 1];
        if (bottom <= top)
        {
            continue;
        }
        if (last && top <= last[1])
        {
            last[1] = Math.max(last[1], bottom);
        }
        else
        {
            merged.push([top, bottom]);
        }
    }
    return merged;
}

/**
 * Works out the pages of one rendered section. docx-preview starts a new
 * section element wherever the document says a page starts, so most are
 * exactly one page. One that is much taller (a document that does not record
 * where its pages start) is cut into pages between lines of text, with its
 * header and footer repeated on each.
 */
function planSection (section: HTMLElement, index: number): PagePlan[]
{
    const view = section.ownerDocument.defaultView!;
    const style = view.getComputedStyle(section);
    const box = section.getBoundingClientRect();
    const width = box.width;
    const full = box.height;
    const paper = parseFloat(style.minHeight);
    const height = paper > 0 ? paper : full;

    if (full <= height + 0.5)
    {
        return [{ section: index, width, height, fit: 1, parts: [{ sourceY: 0, height: full, pageY: 0 }] }];
    }
    if (full <= height * SQUEEZE_LIMIT)
    {
        return [{ section: index, width, height, fit: height / full, parts: [{ sourceY: 0, height: full, pageY: 0 }] }];
    }

    // The body of the section lies between its header and its footer.
    const header = section.querySelector(':scope > header');
    const footer = section.querySelector(':scope > footer');
    let top = parseFloat(style.paddingTop) || 0;
    let bottom = full - (parseFloat(style.paddingBottom) || 0);
    if (header)
    {
        top = Math.max(top, header.getBoundingClientRect().bottom - box.top);
    }
    if (footer)
    {
        bottom = Math.min(bottom, footer.getBoundingClientRect().top - box.top);
    }
    let tail = full - bottom;
    let room = height - top - tail;
    if (room < height / 4)
    {
        // Margins that leave hardly any page: cut the section as it is.
        top = 0;
        tail = 0;
        bottom = full;
        room = height;
    }

    // Candidate cuts: the middle of every gap between solid ranges.
    const solid = solidRanges(section, box.top).filter(([a, b]) => b > top && a < bottom);
    const gaps: number[] = [];
    for (let i = 1; i < solid.length; i++)
    {
        gaps.push((solid[i - 1][1] + solid[i][0]) / 2);
    }

    const plans: PagePlan[] = [];
    let start = top;
    let gap = 0;
    while (start < bottom - 0.5)
    {
        let end = bottom;
        if (end - start > room)
        {
            const limit = start + room;
            end = limit;
            let best = -1;
            for (; gap < gaps.length && gaps[gap] <= limit; gap++)
            {
                if (gaps[gap] > start + 1)
                {
                    best = gaps[gap];
                }
            }
            if (best > 0)
            {
                end = best;
            }
        }
        const parts: Part[] = [{ sourceY: start, height: end - start, pageY: top }];
        if (top > 0)
        {
            parts.push({ sourceY: 0, height: top, pageY: 0 });
        }
        if (tail > 0)
        {
            parts.push({ sourceY: bottom, height: tail, pageY: height - tail });
        }
        plans.push({ section: index, width, height, fit: 1, parts });
        start = end;
    }
    return plans;
}

/**
 * docx-preview cuts a paragraph in two where a page starts inside it, and both
 * halves come out as full paragraphs. Tagging the paragraph beforehand tags
 * both halves, so `joinSplitParagraphs` can find them again.
 */
function markPageSplits (body: any): void
{
    let count = 0;
    for (const paragraph of body?.children ?? [])
    {
        if (paragraph.type !== 'paragraph')
        {
            continue;
        }
        const startsPage = (paragraph.children ?? []).some((run: any) => (run.children ?? []).some(
            (child: any) => child.type === 'break'
                && (child.break === 'page' || child.break === 'lastRenderedPageBreak'),
        ));
        if (startsPage)
        {
            paragraph.className = `${paragraph.className ?? ''} ${SPLIT}${count++}`.trim();
        }
    }
}

function joinSplitParagraphs (doc: Document): void
{
    const halves = new Map<string, HTMLElement[]>();
    for (const paragraph of doc.querySelectorAll<HTMLElement>(`p[class*="${SPLIT}"]`))
    {
        const key = Array.from(paragraph.classList).find((name) => name.startsWith(SPLIT)) ?? '';
        halves.set(key, [...halves.get(key) ?? [], paragraph]);
    }
    for (const [head, rest] of halves.values())
    {
        if (!rest)
        {
            continue;
        }
        if (!head.textContent?.trim() && !head.querySelector('img, svg'))
        {
            // The page starts with this paragraph: nothing of it belongs on the page before.
            head.remove();
            continue;
        }
        rest.classList.add(CONTINUED);
        head.style.marginBottom = '0';
        rest.style.marginTop = '0';
        if (doc.defaultView?.getComputedStyle(head).textAlign === 'justify')
        {
            head.style.textAlignLast = 'justify';
        }
    }
}

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/**
 * Ids of the paragraph styles set to "don't add space between paragraphs of
 * the same style", which list items normally use and docx-preview ignores.
 */
function contextualSpacingStyles (data: ArrayBuffer): Set<string>
{
    const found = new Set<string>();
    const file = unzipSync(new Uint8Array(data), { filter: (entry) => entry.name === 'word/styles.xml' })['word/styles.xml'];
    if (!file)
    {
        return found;
    }
    const xml = new DOMParser().parseFromString(strFromU8(file), 'application/xml');
    const styles = new Map<string, { basedOn: string | null; own: boolean | null }>();
    for (const style of xml.getElementsByTagNameNS(WORD_NS, 'style'))
    {
        const id = style.getAttributeNS(WORD_NS, 'styleId');
        if (!id || style.getAttributeNS(WORD_NS, 'type') !== 'paragraph')
        {
            continue;
        }
        const setting = style.getElementsByTagNameNS(WORD_NS, 'contextualSpacing')[0];
        const value = setting?.getAttributeNS(WORD_NS, 'val');
        styles.set(id, {
            basedOn: style.getElementsByTagNameNS(WORD_NS, 'basedOn')[0]?.getAttributeNS(WORD_NS, 'val') ?? null,
            own: setting ? !(value === '0' || value === 'false' || value === 'off') : null,
        });
    }
    for (const id of styles.keys())
    {
        // The setting is inherited from the style this one is based on.
        let at = styles.get(id);
        for (let depth = 0; at && at.own === null && depth < 20; depth++)
        {
            at = at.basedOn ? styles.get(at.basedOn) : undefined;
        }
        if (at?.own)
        {
            found.add(id);
        }
    }
    return found;
}

/** Removes the space between neighbouring paragraphs that share one of the given style classes. */
function applyContextualSpacing (doc: Document, classNames: readonly string[]): void
{
    for (const name of classNames)
    {
        for (const paragraph of doc.querySelectorAll<HTMLElement>(`p.${CSS.escape(name)}`))
        {
            const before = paragraph.previousElementSibling as HTMLElement | null;
            if (before?.localName === 'p' && before.classList.contains(name))
            {
                before.style.marginBottom = '0';
                paragraph.style.marginTop = '0';
            }
        }
    }
}

/**
 * Word's "multiple" line spacing (1.0, 1.08, 1.15...) multiplies the font's own
 * line height; docx-preview writes it as a CSS number, which multiplies the
 * font size and comes out about a fifth tighter. Scales those numbers by each
 * paragraph's natural line height.
 */
function fixLineSpacing (doc: Document): void
{
    const view = doc.defaultView!;
    const scaled = (style: CSSStyleDeclaration): void =>
    {
        if (/^\d*\.?\d+$/.test(style.lineHeight))
        {
            style.lineHeight = `calc(${style.lineHeight} * var(${LINE}, 1.2))`;
        }
    };
    for (const sheet of doc.styleSheets)
    {
        for (const rule of sheet.cssRules)
        {
            const { style } = rule as CSSStyleRule;
            if (style)
            {
                scaled(style);
            }
        }
    }
    for (const element of doc.querySelectorAll<HTMLElement>('[style*="line-height"]'))
    {
        scaled(element.style);
    }

    // Read every paragraph's font first, then write, so layout runs once.
    const fonts = new Map<HTMLElement, CSSStyleDeclaration>();
    for (const paragraph of doc.querySelectorAll<HTMLElement>(`.${CLASS} p`))
    {
        const walker = doc.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode())
        {
            if (/\S/.test(node.nodeValue ?? '') && node.parentElement)
            {
                fonts.set(paragraph, view.getComputedStyle(node.parentElement));
                break;
            }
        }
    }
    const probe = doc.createElement('span');
    probe.textContent = 'Hg';
    probe.style.cssText = 'position:absolute;visibility:hidden;display:inline-block;'
        + 'font-size:100px;line-height:normal;white-space:nowrap';
    doc.body.append(probe);
    const ratios = new Map<string, string>();
    const keys = new Map<HTMLElement, string>();
    for (const [paragraph, font] of fonts)
    {
        const key = `${font.fontStyle} ${font.fontWeight} ${font.fontFamily}`;
        keys.set(paragraph, key);
        if (!ratios.has(key))
        {
            probe.style.fontFamily = font.fontFamily;
            probe.style.fontWeight = font.fontWeight;
            probe.style.fontStyle = font.fontStyle;
            ratios.set(key, (probe.getBoundingClientRect().height / 100).toFixed(3));
        }
    }
    probe.remove();
    for (const [paragraph, key] of keys)
    {
        paragraph.style.setProperty(LINE, ratios.get(key) ?? '1.2');
    }
}

class WordSource implements SourceDocument
{
    readonly numPages: number;
    private readonly frame: HTMLIFrameElement;
    private readonly sections: HTMLElement[];
    private readonly plans: PagePlan[];
    private readonly css: string;
    /** The section drawn last, kept because consecutive pages often share one. */
    private cached: { section: number; image: Promise<HTMLImageElement> } | null = null;

    constructor (frame: HTMLIFrameElement)
    {
        const doc = frame.contentDocument!;
        this.frame = frame;
        this.sections = Array.from(doc.querySelectorAll<HTMLElement>(`.${CLASS}-wrapper > section.${CLASS}`));
        this.plans = this.sections.flatMap(planSection);
        // From the live rules, not the <style> text: fixLineSpacing edited them.
        this.css = Array.from(doc.styleSheets)
            .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
            .join('\n');
        this.numPages = this.plans.length;
    }

    getPage (number: number): Promise<SourcePage>
    {
        const plan = this.plans[number - 1];
        if (!plan)
        {
            return Promise.reject(new Error(`No page ${number}`));
        }
        return Promise.resolve({
            width: plan.width / CSS_PX_PER_POINT,
            height: plan.height / CSS_PX_PER_POINT,
            render: (ctx, scale) => this.draw(plan, ctx, scale),
            cleanup: () => undefined,
        });
    }

    close (): Promise<void>
    {
        this.cached = null;
        this.frame.remove();
        return Promise.resolve();
    }

    private async draw (plan: PagePlan, ctx: CanvasRenderingContext2D, scale: number): Promise<void>
    {
        const image = await this.sectionImage(plan.section);
        // Canvas pixels per CSS pixel of the page, and of the section drawn on it.
        const page = scale / CSS_PX_PER_POINT;
        const k = page * plan.fit;
        const left = plan.width * (1 - plan.fit) / 2 * page;

        ctx.save();
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.imageSmoothingQuality = 'high';
        for (const part of plan.parts)
        {
            ctx.drawImage(
                image,
                0, part.sourceY, plan.width, part.height,
                left, part.pageY * page, plan.width * k, part.height * k,
            );
        }
        ctx.restore();
    }

    private sectionImage (index: number): Promise<HTMLImageElement>
    {
        if (this.cached?.section !== index)
        {
            this.cached = { section: index, image: this.loadSection(index) };
        }
        return this.cached.image;
    }

    /**
     * Turns one section into an image the browser itself lays out and paints:
     * an SVG holding the section's HTML and the document's styles.
     */
    private async loadSection (index: number): Promise<HTMLImageElement>
    {
        const doc = this.frame.contentDocument;
        if (!doc)
        {
            throw new Error('The document was closed.');
        }
        const section = this.sections[index];
        const box = section.getBoundingClientRect();

        const root = doc.createElement('div');
        root.className = `${CLASS}-wrapper`;
        const style = doc.createElement('style');
        style.textContent = this.css;
        root.append(style);

        // List numbers are CSS counters that run through the whole document.
        // Empty copies of the numbered paragraphs before this section bring
        // the counters to where the section picks them up.
        const counted = doc.createElement('div');
        counted.setAttribute('style', 'height:0;overflow:hidden;visibility:hidden');
        for (const earlier of this.sections.slice(0, index))
        {
            for (const paragraph of earlier.querySelectorAll(`p[class*="${CLASS}-num-"]`))
            {
                counted.append(paragraph.cloneNode(false));
            }
        }
        root.append(counted, section.cloneNode(true));

        const html = new XMLSerializer().serializeToString(root)
            // Characters XML does not allow, which would make the image fail to load.
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(box.width)}" height="${Math.ceil(box.height)}">`
            + `<foreignObject x="0" y="0" width="100%" height="100%">${html}</foreignObject></svg>`;

        const image = new Image();
        // A data: URL, because a canvas that drew such an SVG from a blob: URL
        // cannot be read back in every browser.
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        try
        {
            await image.decode();
        }
        catch
        {
            throw new Error('The browser could not draw this page of the document.');
        }
        return image;
    }
}

function sleep (ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A hidden frame gives the document a page of its own, away from this app's styles. */
async function createFrame (): Promise<HTMLIFrameElement>
{
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;height:800px;border:0;visibility:hidden';
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
    document.body.append(frame);
    await loaded;
    return frame;
}

/**
 * Opens a .docx file: docx-preview lays it out as HTML in a hidden frame, and
 * each page is drawn from that on request.
 */
export async function openDocx (data: ArrayBuffer): Promise<SourceDocument>
{
    const magic = new Uint8Array(data.slice(0, 4));
    if (magic[0] === 0xD0 && magic[1] === 0xCF && magic[2] === 0x11 && magic[3] === 0xE0)
    {
        throw new UnsupportedFileError(
            'This Word document is password protected or in the old .doc format. '
            + 'Save it as an unprotected .docx and add it again.',
        );
    }

    const frame = await createFrame();
    try
    {
        const doc = frame.contentDocument!;
        let tight: string[] = [];
        try
        {
            const options = {
                className: CLASS,
                inWrapper: true,
                // Start pages where Word last started them, not only at explicit breaks.
                ignoreLastRenderedPageBreak: false,
                // Pictures and fonts as data: URLs; the page images cannot load anything else.
                useBase64URL: true,
                // Tab stops.
                experimental: true,
            };
            const parsed = await parseAsync(data, options);
            markPageSplits(parsed.documentPart?.body);
            for (const node of await renderDocument(parsed, options))
            {
                (node.nodeName === 'STYLE' ? doc.head : doc.body).append(node);
            }
            const ids = contextualSpacingStyles(data);
            tight = (parsed.stylesPart?.styles ?? [])
                .filter((entry: any) => ids.has(entry.id) && entry.cssName)
                .map((entry: any) => entry.cssName);
        }
        catch (error)
        {
            console.error(error);
            throw new UnsupportedFileError('This file is not a valid Word document or is damaged.');
        }
        const style = doc.createElement('style');
        style.textContent = PAGE_CSS;
        doc.head.append(style);
        applyContextualSpacing(doc, tight);
        joinSplitParagraphs(doc);

        // A timer with the same delay, started later, fires after the library's.
        await sleep(TAB_STOP_DELAY);
        await Promise.all(Array.from(doc.images, (image) => image.decode().catch(() => undefined)));
        await doc.fonts.ready;
        fixLineSpacing(doc);

        const source = new WordSource(frame);
        if (source.numPages === 0)
        {
            throw new UnsupportedFileError('This Word document has no pages.');
        }
        return source;
    }
    catch (error)
    {
        frame.remove();
        throw error;
    }
}
