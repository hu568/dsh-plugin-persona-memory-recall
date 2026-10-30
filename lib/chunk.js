/**
 * 把一条长日志切成 BM25 可打分的片段。
 *
 * JOURNAL 的条目实测平均 ≈2.6 KB，按整条打分会被「一条里的其他段落」稀释，
 * 所以先按句末标点/换行切，再合并到 maxChars；单句超长时硬切。
 * 换行在合并时保留，避免把列表/代码块粘成一行。
 */

/**
 * @param {string} text 条目正文。
 * @param {{ maxChars?: number, maxChunks?: number, minChars?: number }} [options]
 * @returns {string[]} 片段列表（有序、已去空）。
 */
export function chunkText(text, options = {}) {
    const maxChars = options.maxChars ?? 300;
    const maxChunks = options.maxChunks ?? 12;
    const minChars = options.minChars ?? 8;
    const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (normalized === '') return [];

    // 保留分隔符：中文句号/问叹号/分号、英文句号/叹问号、换行。
    const pieces = normalized.split(/(?<=[。！？；;!?\n])/u);
    const chunks = [];
    let buffer = '';
    let pending = '';

    const flush = () => {
        const value = buffer.trim();
        if (value !== '') chunks.push(value);
        buffer = '';
        pending = '';
    };

    for (const rawPiece of pieces) {
        const piece = rawPiece.trim();
        const newlineAfter = rawPiece.endsWith('\n');
        if (piece === '') {
            if (newlineAfter) pending = '\n';
            continue;
        }
        if (piece.length > maxChars) {
            flush();
            for (let offset = 0; offset < piece.length; offset += maxChars) {
                chunks.push(piece.slice(offset, offset + maxChars));
            }
            continue;
        }
        const separator = buffer === '' ? '' : pending;
        if (buffer.length + separator.length + piece.length > maxChars) {
            flush();
            buffer = piece;
        } else {
            buffer += separator + piece;
        }
        pending = newlineAfter ? '\n' : '';
    }
    flush();

    // 丢掉过短片段（「---」「ok」之类），但至少保留一段，避免整条消失。
    const kept = chunks.filter((chunk) => chunk.length >= minChars);
    return (kept.length > 0 ? kept : chunks).slice(0, maxChunks);
}
