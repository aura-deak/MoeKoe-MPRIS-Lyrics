#!/usr/bin/env node
/**
 * lyrics-parser.js 单元测试
 * 运行：node tests/test-lyrics-parser.js
 */
'use strict';

const assert = require('assert');
const parser = require('../lyrics-parser.js');

const failures = [];
function check(condition, message) {
  if (condition) {
    console.log('  ok   ' + message);
  } else {
    console.log('  FAIL ' + message);
    failures.push(message);
  }
}

// 构造与酷狗 KRC 一致的样本：language 标签 + 行级时间标签 + 逐字标签
const languageTag = {
  content: [
    { type: 1, lyricContent: [['在水中'], ['抓住光芒']] },
    { type: 0, lyricContent: [['i no na ka de'], ['hi ko o tsu ka mu']] }
  ]
};
const languageBase64 = Buffer.from(JSON.stringify(languageTag), 'utf8').toString('base64');

const krc = [
  '[ar:まふまふ]',
  '[ti:うぉーたーりょー]',
  '[language:' + languageBase64 + ']',
  '[0,4000]<0,300,0>水<300,300,0>の<600,300,0>中<900,300,0>で',
  '[4000,4000]<0,400,0>光<400,400,0>を<800,400,0>つかむ',
  '[8000,2000]'
].join('\n');

console.log('\n[KRC 解析]');
const parsed = parser.parse(krc);
check(parsed.format === 'krc', '识别为 KRC');
check(parsed.lines.length === 2, '解析出 2 行有效歌词（空行被忽略）');
check(parsed.lines[0].text === '水の中で', '逐字标签被去除：' + parsed.lines[0].text);
check(parsed.lines[0].start === 0 && parsed.lines[0].duration === 4000, '行级时间标签正确');
check(parsed.lines[0].translation === '在水中', '翻译按行对齐');
check(parsed.lines[1].translation === '抓住光芒', '第二行翻译正确');
check(parsed.lines[1].index === 1, 'index 连续编号');

console.log('\n[当前行定位]');
check(parser.findLineIndex(parsed.lines, -100) === -1, '第一行之前返回 -1');
check(parser.findLineIndex(parsed.lines, 0) === 0, 't=0ms -> 第 0 行');
check(parser.findLineIndex(parsed.lines, 3999) === 0, 't=3999ms -> 第 0 行');
check(parser.findLineIndex(parsed.lines, 4000) === 1, 't=4000ms -> 第 1 行');
check(parser.findLineIndex(parsed.lines, 60000) === 1, '末行之后保持最后一行');

console.log('\n[三种传输模式投影]');
const original = parser.projectLines(parsed.lines, 'original');
check(original[0].text === '水の中で' && !('translation' in original[0]), '单歌词：只有原文');
const translation = parser.projectLines(parsed.lines, 'translation');
check(!('text' in translation[0]) && translation[0].translation === '在水中', '单翻译：只有译文');
const both = parser.projectLines(parsed.lines, 'both');
check(both[0].text === '水の中で' && both[0].translation === '在水中', '歌词翻译：原文 + 译文');
check(parser.normalizeMode('bogus') === 'both', '非法模式回退到 both');
check(parser.modeLabel('translation') === '单翻译', '模式中文标签');

console.log('\n[LRC 兜底]');
const lrc = '[ti:测试]\n[00:01.50]第一行\n[00:04.00]第二行\n[00:04.00]重复时间戳\n';
const parsedLrc = parser.parse(lrc);
check(parsedLrc.format === 'lrc', '识别为 LRC');
check(parsedLrc.lines.length === 3, 'LRC 解析出 3 行');
check(parsedLrc.lines[0].start === 1500, 'LRC 时间 00:01.50 = 1500ms');
check(parsedLrc.lines[1].text === '第二行', 'LRC 正文正确');
check(parser.findLineIndex(parsedLrc.lines, 2000) === 0, 'LRC 当前行定位');

console.log('\n[空输入]');
check(parser.parse('').format === 'none', '空串返回 none');
check(parser.parse(null).format === 'none', 'null 返回 none');
check(parser.parse('[ar:x]\n没有时间标签').format === 'none', '无时间标签返回 none');

console.log('');
if (failures.length) {
  console.log('FAILED: ' + failures.length + ' 项未通过');
  process.exit(1);
}
console.log('ALL PASSED');
