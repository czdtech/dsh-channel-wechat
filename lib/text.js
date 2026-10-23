export const TASK_HEADING = '【任务理解】';
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]+)\]\([^)]+\)/g;
const H5_H6 = /^#{5,6}\s+/gm;
const BULLET = /^\s*[-*+]\s+/gm;
const ORDERED = /^\s*\d+\.\s+/gm;
const QUOTE = /^\s*>\s?/gm;
const MANY_BLANK_LINES = /\n{3,}/g;
const TASK_PREFIX = /^(?:[#>*+-]\s*)*【任务理解】/;
export function looksLikeTaskUnderstanding(text, marker = TASK_HEADING) {
    if (marker === TASK_HEADING)
        return TASK_PREFIX.test(text.replace(/^\s+/, ''));
    return text.replace(/^\s+/, '').replace(/^(?:[#>*+-]\s*)*/, '').startsWith(marker);
}
export function cleanForWeChat(text) {
    return text
        .replace(IMAGE, '')
        .replace(LINK, '$1')
        .replace(H5_H6, '')
        .replace(BULLET, '• ')
        .replace(ORDERED, '')
        .replace(QUOTE, '')
        .replace(MANY_BLANK_LINES, '\n\n')
        .trim();
}
export function splitChunks(text, budgetBytes = 1800) {
    const trimmed = text.trim();
    if (!trimmed)
        return [];
    const chunks = [];
    let rest = Array.from(trimmed);
    while (rest.length > 0) {
        let bytes = 0;
        let cut = 0;
        for (; cut < rest.length; cut += 1) {
            const size = Buffer.byteLength(rest[cut], 'utf8');
            if (bytes + size > budgetBytes)
                break;
            bytes += size;
        }
        if (cut === 0)
            cut = 1;
        if (cut >= rest.length) {
            const chunk = rest.join('');
            if (chunk.trim())
                chunks.push(chunk);
            break;
        }
        const floor = Math.max(1, Math.floor(cut / 2));
        let boundary = -1;
        for (let index = cut - 1; index >= floor; index -= 1) {
            const value = rest[index];
            if (value === '\n' || value === ' ') {
                boundary = index;
                break;
            }
        }
        const at = boundary >= floor ? boundary + 1 : cut;
        const chunk = rest.slice(0, at).join('').replace(/\n+$/, '');
        rest = rest.slice(at);
        while (rest[0] === '\n')
            rest.shift();
        if (chunk.trim())
            chunks.push(chunk);
        else if (chunk && chunks.length > 0)
            chunks[chunks.length - 1] += chunk;
    }
    return chunks;
}
export function withChunkPrefix(chunk, index, total) {
    return total > 1 ? `[${index}/${total}]\n${chunk}` : chunk;
}
export function extractPreToolText(content) {
    if (!Array.isArray(content))
        return ['', false];
    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== 'object')
            continue;
        const typed = block;
        if (typed.type === 'tool-call')
            return [parts.filter(Boolean).join('\n').trim(), true];
        if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
            parts.push(typed.text);
        }
    }
    return ['', false];
}
export function extractPlainAssistantText(content) {
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== 'object')
            continue;
        const typed = block;
        if (typed.type === 'tool-call')
            return '';
        if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
            parts.push(typed.text);
        }
    }
    return parts.join('\n').trim();
}
//# sourceMappingURL=text.js.map