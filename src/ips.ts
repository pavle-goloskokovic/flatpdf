/**
 * The text inside an NBS IPS QR code: `TAG:value` pairs separated by `|`, as
 * laid out in Annex 1 of the National Bank of Serbia's decision on instant
 * credit transfers. For example:
 *
 *   K:PR|V:01|C:1|R:845000000040484987|N:JP EPS BEOGRAD|I:RSD3596,13|SF:189|RO:97163220000111111111000
 */

export interface IpsField
{
    /** Empty for a piece that is not a `TAG:value` pair; it is kept as it was. */
    tag: string;
    value: string;
}

export interface IpsCode
{
    fields: IpsField[];
}

/** What the payment slip form shows and edits. */
export interface SlipValues
{
    /** K: what the code is for (PR, PT, PK or EK). */
    kind: string;
    /** P, one line per row. */
    payer: string;
    /** S. */
    purpose: string;
    /** N, one line per row. */
    payee: string;
    /** SF. */
    code: string;
    /** First part of I. */
    currency: string;
    /** Second part of I, the way people write it: 3.596,13 */
    amount: string;
    /** R, shown as 845-0000000404849-87. */
    account: string;
    /** First two digits of RO. */
    model: string;
    /** The rest of RO. */
    reference: string;
    /** Every other field in the code, by tag. */
    extra: Record<string, string>;
}

/** The order the specification lists the tags in; new fields are slotted in by it. */
const ORDER = ['K', 'V', 'C', 'R', 'N', 'I', 'O', 'P', 'SF', 'S', 'M', 'JS', 'RO', 'RL', 'RP'];
/** Tags the slip itself covers, plus the two fixed ones that are never shown. */
const SLIP_TAGS = new Set(['K', 'V', 'C', 'R', 'N', 'I', 'P', 'SF', 'S', 'RO']);

export const KINDS: Record<string, string> = {
    PR: 'PR · printed bill',
    PT: 'PT · point of sale, shown by the merchant',
    PK: 'PK · point of sale, shown by the buyer',
    EK: 'EK · online shop',
};

export const EXTRA_LABELS: Record<string, string> = {
    O: 'Payer account (O)',
    M: 'Merchant category code (M)',
    JS: 'Payer one-time code (JS)',
    RL: 'Payee reference (RL)',
    RP: 'Point of sale reference (RP)',
};

/** Returns null when the text is not an NBS IPS code. */
export function parseIps (text: string): IpsCode | null
{
    const fields = text.split('|').map((part): IpsField =>
    {
        const colon = part.indexOf(':');
        return colon > 0 && /^[A-Z]{1,2}$/.test(part.slice(0, colon))
            ? { tag: part.slice(0, colon), value: part.slice(colon + 1) }
            : { tag: '', value: part };
    });
    const code = { fields };
    const kind = get(code, 'K');
    if (fields[0]?.tag !== 'K' || kind === null || !/^[A-Z]{2}$/.test(kind))
    {
        return null;
    }
    // Every kind of IPS code names at least a payee account or an amount.
    if (get(code, 'R') === null && get(code, 'I') === null && get(code, 'O') === null)
    {
        return null;
    }
    return code;
}

export function serializeIps (code: IpsCode): string
{
    return code.fields.map((f) => (f.tag ? `${f.tag}:${f.value}` : f.value)).join('|');
}

function get (code: IpsCode, tag: string): string | null
{
    return code.fields.find((f) => f.tag === tag)?.value ?? null;
}

const lines = (value: string): string => value.replace(/\r\n?/g, '\n');

function groupThousands (digits: string): string
{
    return digits.replace(/\B(?=(\d{3})+$)/g, '.');
}

/** "3596,1" -> "3.596,10". Anything unexpected is shown as it is. */
function showAmount (raw: string): string
{
    const match = /^(\d+)(?:[,.](\d*))?$/.exec(raw);
    if (!match)
    {
        return raw;
    }
    const whole = match[1].replace(/^0+(?=\d)/, '');
    return `${groupThousands(whole)},${(match[2] ?? '').padEnd(2, '0')}`;
}

/**
 * Reads an amount the way it is written in Serbia (1.234,56), also accepting
 * 1234.56. Returns it as the code stores it (1234,56), or null.
 */
export function readAmount (input: string): string | null
{
    const text = input.replace(/\s/g, '');
    let whole: string;
    let cents = '';
    if (text.includes(','))
    {
        const at = text.lastIndexOf(',');
        whole = text.slice(0, at).replace(/\./g, '');
        cents = text.slice(at + 1);
    }
    else if (/^\d+\.\d{1,2}$/.test(text))
    {
        [whole, cents] = text.split('.');
    }
    else
    {
        whole = text.replace(/\./g, '');
    }
    if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(cents))
    {
        return null;
    }
    return `${whole.replace(/^0+(?=\d)/, '')},${cents.padEnd(2, '0')}`;
}

/** Whole digits an amount may have: the code allows up to RSD99999999999999,99. */
const MAX_AMOUNT_DIGITS = 14;

export interface CheckedAmount
{
    /** The amount written out in full, as on a paper slip: 1.250,00. The input itself when it is wrong. */
    shown: string;
    /** What is wrong with it, or an empty string. An empty amount is not an error here. */
    error: string;
}

/** Checks an amount as it is typed into the slip. */
export function checkAmount (input: string): CheckedAmount
{
    const text = input.trim();
    if (text === '')
    {
        return { shown: '', error: '' };
    }
    const fail = (error: string): CheckedAmount => ({ shown: input, error });
    if (/[^\d.,\s]/.test(text))
    {
        return fail('Use digits only, with a comma before the paras: 1.250,00');
    }
    if (/,\d{3,}$/.test(text.replace(/\s/g, '')))
    {
        return fail('An amount has two decimals at most: 1.250,00');
    }
    const amount = readAmount(text);
    if (amount === null)
    {
        return fail('This is not an amount. Write it like 1.250,00');
    }
    if (!/[1-9]/.test(amount))
    {
        return fail('The amount must be more than zero.');
    }
    if (amount.indexOf(',') > MAX_AMOUNT_DIGITS)
    {
        return fail('The amount is too large for the code.');
    }
    return { shown: showAmount(amount), error: '' };
}

function showAccount (raw: string): string
{
    return /^\d{18}$/.test(raw) ? `${raw.slice(0, 3)}-${raw.slice(3, 16)}-${raw.slice(16)}` : raw;
}

/** "845-404849-87" -> "845000000040484987": the middle part is padded with zeros. */
function readAccount (input: string): string
{
    const parts = input.trim().split(/\s*-\s*/);
    if (parts.length === 3 && parts.every((part) => /^\d+$/.test(part)) && parts[1].length <= 13)
    {
        return parts[0] + parts[1].padStart(13, '0') + parts[2];
    }
    return input.replace(/[\s-]/g, '');
}

/** Remainder of a long decimal number divided by 97. */
function mod97 (digits: string): number
{
    let rest = 0;
    for (const digit of digits)
    {
        rest = (rest * 10 + Number(digit)) % 97;
    }
    return rest;
}

/** The last two digits of an account number are 98 minus the rest modulo 97. */
function accountChecks (account: string): boolean
{
    return 98 - mod97(`${account.slice(0, 16)}00`) === Number(account.slice(16));
}

/**
 * Model 97: the reference starts with two control digits, 98 minus the rest
 * modulo 97, where letters count as A = 10 … Z = 35.
 */
function model97Checks (reference: string): boolean | null
{
    const plain = reference.replace(/[\s-]/g, '').toUpperCase();
    if (!/^\d{2}[0-9A-Z]+$/.test(plain))
    {
        return null;
    }
    const digits = plain.slice(2).replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
    return 98 - mod97(`${digits}00`) === Number(plain.slice(0, 2));
}

export function toValues (code: IpsCode): SlipValues
{
    const amount = get(code, 'I') ?? '';
    const currency = /^[A-Za-z]{3}/.exec(amount)?.[0] ?? '';
    const reference = get(code, 'RO') ?? '';
    const model = /^\d{2}/.exec(reference)?.[0] ?? '';
    const extra: Record<string, string> = {};
    for (const field of code.fields)
    {
        if (field.tag && !SLIP_TAGS.has(field.tag) && !(field.tag in extra))
        {
            extra[field.tag] = lines(field.value);
        }
    }
    return {
        kind: get(code, 'K') ?? '',
        payer: lines(get(code, 'P') ?? ''),
        purpose: lines(get(code, 'S') ?? ''),
        payee: lines(get(code, 'N') ?? ''),
        code: get(code, 'SF') ?? '',
        currency: currency || 'RSD',
        amount: showAmount(amount.slice(currency.length)),
        account: showAccount(get(code, 'R') ?? ''),
        model,
        reference: reference.slice(model.length),
        extra,
    };
}

export interface BuiltIps
{
    text: string;
    warnings: string[];
}

/**
 * Writes the form back into the code. A field whose form value was not touched
 * keeps its original characters exactly; a field that was emptied is left out,
 * as the specification asks for optional fields.
 */
export function buildIps (code: IpsCode, initial: SlipValues, now: SlipValues): BuiltIps
{
    const warnings: string[] = [];
    const fields = code.fields.map((f) => ({ ...f }));
    // Keep the line break the code already uses inside names and addresses.
    const joined = fields.map((f) => f.value).join('');
    const newline = joined.includes('\r\n') || !joined.includes('\n') ? '\r\n' : '\n';
    let barDropped = false;

    const tidy = (value: string): string =>
    {
        if (value.includes('|'))
        {
            barDropped = true;
        }
        return value.replace(/\|/g, '').trim();
    };
    const rows = (value: string): string => value.split('\n').map(tidy).filter(Boolean).join(newline);
    const oneLine = (value: string): string => tidy(value.replace(/\s*\n\s*/g, ' '));

    const set = (tag: string, changed: boolean, value: () => string): void =>
    {
        if (!changed)
        {
            return;
        }
        const raw = value();
        const at = fields.findIndex((f) => f.tag === tag);
        if (raw === '')
        {
            if (at >= 0)
            {
                fields.splice(at, 1);
            }
        }
        else if (at >= 0)
        {
            fields[at].value = raw;
        }
        else
        {
            const rank = ORDER.indexOf(tag);
            const before = rank < 0 ? -1 : fields.findIndex((f) => ORDER.indexOf(f.tag) > rank);
            // A code that ends with a stray "|" keeps it at the very end.
            const end = fields.length && !fields[fields.length - 1].tag && !fields[fields.length - 1].value
                ? fields.length - 1
                : fields.length;
            fields.splice(before < 0 ? end : before, 0, { tag, value: raw });
        }
    };

    set('K', now.kind !== initial.kind, () => tidy(now.kind));
    set('R', now.account !== initial.account, () => tidy(readAccount(now.account)));
    set('N', now.payee !== initial.payee, () => rows(now.payee));
    set('I', now.amount !== initial.amount || now.currency !== initial.currency, () =>
    {
        const text = tidy(now.amount);
        return text === '' ? '' : now.currency + (readAmount(text) ?? text);
    });
    set('P', now.payer !== initial.payer, () => rows(now.payer));
    set('SF', now.code !== initial.code, () => tidy(now.code));
    set('S', now.purpose !== initial.purpose, () => oneLine(now.purpose));
    set('RO', now.model !== initial.model || now.reference !== initial.reference, () =>
    {
        const reference = tidy(now.reference);
        return reference === '' ? '' : tidy(now.model) + reference;
    });
    for (const tag of Object.keys(now.extra))
    {
        set(tag, now.extra[tag] !== initial.extra[tag], () => rows(now.extra[tag]));
    }

    if (barDropped)
    {
        warnings.push('The | character separates fields in the code, so it was left out.');
    }

    const result: IpsCode = { fields };
    const value = (tag: string): string => get(result, tag) ?? '';
    const length = (tag: string): number => [...lines(value(tag))].length;
    const tooLong = (tag: string, name: string, max: number): void =>
    {
        if (length(tag) > max)
        {
            warnings.push(`${name} is ${length(tag)} characters; the code allows ${max}.`);
        }
    };
    const kind = value('K');
    const payeeNeeded = kind !== 'PK';

    if (!(kind in KINDS))
    {
        warnings.push(`Code type "${kind}" is not one of PR, PT, PK, EK.`);
    }
    const account = value('R');
    if (account === '' ? payeeNeeded : !/^\d{18}$/.test(account))
    {
        warnings.push('Payee account (рачун примаоца) must be 18 digits, for example 845-0000000404849-87.');
    }
    else if (account && !accountChecks(account))
    {
        warnings.push('Payee account (рачун примаоца): the last two digits do not match the rest of the number.');
    }
    if (payeeNeeded && value('N') === '')
    {
        warnings.push('Payee (прималац) is missing.');
    }
    tooLong('N', 'Payee (прималац)', 70);
    tooLong('P', 'Payer (уплатилац)', 70);
    tooLong('S', 'Purpose (сврха уплате)', 35);
    tooLong('RO', 'Model and reference (модел и позив на број)', 35);
    tooLong('RL', 'Payee reference (RL)', 140);

    const amount = value('I');
    if (amount === '' ? payeeNeeded : !/^[A-Z]{3}\d+,\d{0,2}$/.test(amount))
    {
        warnings.push('Amount (износ) must be a number such as 3.596,13.');
    }
    else if (amount && !/[1-9]/.test(amount))
    {
        warnings.push('Amount (износ) is zero.');
    }
    else if (amount.length > 20)
    {
        warnings.push('Amount (износ) is too large for the code.');
    }
    const payment = value('SF');
    if (payment === '' ? payeeNeeded : !/^\d{3}$/.test(payment))
    {
        warnings.push('Payment code (шифра плаћања) must be three digits, for example 189 or 289.');
    }
    const payerAccount = value('O');
    if (payerAccount && !/^\d{18}$/.test(payerAccount))
    {
        warnings.push('Payer account (O) must be 18 digits.');
    }

    const model = tidy(now.model);
    const reference = tidy(now.reference);
    if (model && !/^\d{2}$/.test(model))
    {
        warnings.push('Model (модел) must be two digits: 97, 11 or 00.');
    }
    else if (model && !reference)
    {
        warnings.push('The model (модел) is only stored together with a reference (позив на број).');
    }
    else if (model === '97' && model97Checks(reference) === false)
    {
        warnings.push('Reference (позив на број): the first two digits do not match the rest under model 97.');
    }
    else if (model === '97' && model97Checks(reference) === null)
    {
        warnings.push('Reference (позив на број): model 97 takes two control digits followed by digits and letters.');
    }

    return { text: serializeIps(result), warnings };
}
