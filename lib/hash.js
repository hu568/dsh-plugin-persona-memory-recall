/**
 * 片段指纹：跨轮去重要判断「这段是不是刚注入过」。
 *
 * 为什么按**原始片段正文**算，而不是按渲染后的行算：渲染会加日期标签、按剩余预算
 * 截断、还可能因为开窗位置不同而取到不同子串；同一个片段在两轮里渲染结果可能不同，
 * 但它在日志里还是同一段话。用原始片段归一化后的哈希当身份，才不会「换个窗口就重注入」。
 */

import { createHash } from 'node:crypto';
import { normalize } from './tokenize.js';

/**
 * 片段指纹（sha256 前 16 位十六进制）。
 *
 * @param {string} text 原始片段正文。
 * @returns {string}
 */
export function chunkHash(text) {
    return createHash('sha256').update(normalize(text)).digest('hex').slice(0, 16);
}
