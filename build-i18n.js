/**
 * languages.js 压缩构建脚本
 * 使用 vm 执行 languages.js 提取所有5种语言
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, 'languages.js'), 'utf-8');
const sandbox = { module: {}, exports: {} };
const context = vm.createContext(sandbox);
vm.runInContext(source + '; this._result = LANGUAGES;', context);
const LANGUAGES = sandbox._result || {};

// 压缩为单行JSON，包含所有5种语言
const minContent = '/* FoodFlow i18n - compressed (all languages) */window.LANGUAGES=' + JSON.stringify(LANGUAGES) + ';';

fs.writeFileSync(path.join(__dirname, 'languages.min.js'), minContent, 'utf-8');

const originalSize = fs.statSync(path.join(__dirname, 'languages.js')).size;
const minSize = Buffer.byteLength(minContent, 'utf-8');
console.log('languages.min.js 已生成');
console.log('  原始大小:', (originalSize / 1024).toFixed(1), 'KB');
console.log('  压缩大小:', (minSize / 1024).toFixed(1), 'KB');
console.log('  减少:', ((1 - minSize / originalSize) * 100).toFixed(1) + '%');
['zh','en','vi','th','km'].forEach(l => {
    console.log('  ' + l + ' 键数:', LANGUAGES[l] ? Object.keys(LANGUAGES[l]).length : 'MISSING');
});
