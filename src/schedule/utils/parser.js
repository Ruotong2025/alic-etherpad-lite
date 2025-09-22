/**
 * Changeset解析工具
 */

// Base36解析
function parseNum(str) {
  return parseInt(str, 36);
}

// 中英文分词器
function tokenizeText(text) {
  if (!text) return [];
  
  const tokens = [];
  let currentWord = '';
  let position = 0;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    if (char === '\n') {
      if (currentWord) {
        tokens.push({ text: currentWord, type: 'word', start: position - currentWord.length, end: position });
        currentWord = '';
      }
      tokens.push({ text: char, type: 'newline', start: position, end: position + 1 });
    } else if (char.match(/\s/)) {
      if (currentWord) {
        tokens.push({ text: currentWord, type: 'word', start: position - currentWord.length, end: position });
        currentWord = '';
      }
      tokens.push({ text: char, type: 'space', start: position, end: position + 1 });
    } else if (char.match(/[a-zA-Z0-9]/)) {
      currentWord += char;
    } else if (char.match(/[\u4e00-\u9fff]/)) {
      // 中文字符，每个字符作为一个词
      if (currentWord) {
        tokens.push({ text: currentWord, type: 'word', start: position - currentWord.length, end: position });
        currentWord = '';
      }
      tokens.push({ text: char, type: 'word', start: position, end: position + 1 });
    } else {
      // 标点符号
      if (currentWord) {
        tokens.push({ text: currentWord, type: 'word', start: position - currentWord.length, end: position });
        currentWord = '';
      }
      tokens.push({ text: char, type: 'punctuation', start: position, end: position + 1 });
    }
    position++;
  }
  
  if (currentWord) {
    tokens.push({ text: currentWord, type: 'word', start: position - currentWord.length, end: position });
  }
  
  return tokens;
}

// 获取文本中的词汇
function getWords(text) {
  return tokenizeText(text).filter(token => token.type === 'word').map(token => token.text);
}

// 计算词位置
// 基于Etherpad源代码的位置计算 - 重写版
function calculatePosition(charOffset, documentText) {
  if (!documentText) {
    return { line: 1, wordIndex: 1 };
  }
  
  // 处理边界情况
  if (charOffset <= 0) {
    return { line: 1, wordIndex: 1 };
  }
  
  if (charOffset >= documentText.length) {
    // 如果超出文档长度，计算最后位置
    const lines = documentText.split('\n');
    const lastLine = lines[lines.length - 1] || '';
    const wordsInLastLine = countWordsInLine(lastLine);
    return { 
      line: lines.length, 
      wordIndex: wordsInLastLine + 1 
    };
  }
  
  // 计算到指定位置的文本
  const textUpToOffset = documentText.substring(0, charOffset);
  const lines = textUpToOffset.split('\n');
  
  // 行数计算
  const lineNumber = lines.length;
  
  // 当前行的文本（到charOffset位置为止）
  const currentLineText = lines[lines.length - 1] || '';
  
  // 计算当前行中的词数
  const wordIndex = countWordsInLine(currentLineText) + 1;
  
  return { line: lineNumber, wordIndex };
}

// 辅助函数：计算行中的词数
// 中文按字分词，英文按单词分词
function countWordsInLine(lineText) {
  if (!lineText) return 0;
  
  let wordCount = 0;
  let i = 0;
  
  while (i < lineText.length) {
    const char = lineText[i];
    
    // 跳过空白字符
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    
    // 中文字符（每个字符算一个词）
    if (/[\u4e00-\u9fff]/.test(char)) {
      wordCount++;
      i++;
    }
    // 英文字母、数字（连续的算一个词）
    else if (/[a-zA-Z0-9]/.test(char)) {
      wordCount++;
      // 跳过同一个英文单词的其他字符
      while (i < lineText.length && /[a-zA-Z0-9]/.test(lineText[i])) {
        i++;
      }
    }
    // 标点符号等（每个算一个词）
    else {
      wordCount++;
      i++;
    }
  }
  
  return wordCount;
}

// 解析changeset头部
function parseChangeset(changeset) {
  const headerRegex = /Z:([0-9a-z]+)([><])([0-9a-z]+)/;
  const match = headerRegex.exec(changeset);
  
  if (!match) {
    throw new Error(`无效的changeset格式: ${changeset}`);
  }
  
  const oldLen = parseNum(match[1]);
  const changeSign = match[2] === '>' ? 1 : -1;
  const changeMag = parseNum(match[3]);
  const newLen = oldLen + changeSign * changeMag;
  
  return {
    oldLen,
    newLen,
    lengthChange: changeSign * changeMag,
    opsStart: match[0].length
  };
}

// 解析操作序列
function parseOperations(opsStr) {
  const operations = [];
  const regex = /((?:\*[0-9a-z]+)*)(?:\|([0-9a-z]+))?([-+=])([0-9a-z]+)/g;
  
  let match;
  while ((match = regex.exec(opsStr)) !== null) {
    operations.push({
      opcode: match[3],
      chars: parseNum(match[4]),
      lines: match[2] ? parseNum(match[2]) : 0,
      attribs: match[1] || ''
    });
  }
  
  return operations;
}

// 分析changeset变更内容
function analyzeChangesetContent(changeset, baseDocument = '') {
  try {
    if (!changeset || changeset.trim() === '') {
      return {
        changes: [],
        summary: '空changeset',
        lengthChange: 0,
        change_description: '空changeset',
        change_position: null
      };
    }

    const dollarIndex = changeset.indexOf('$');
    const opsEnd = dollarIndex >= 0 ? dollarIndex : changeset.length;
    const charBank = dollarIndex >= 0 ? changeset.slice(dollarIndex + 1) : '';
    
    const header = parseChangeset(changeset);
    const opsStr = changeset.slice(header.opsStart, opsEnd);
    const operations = parseOperations(opsStr);
    
    // 处理隐式操作和不完整的操作字符串
    if (operations.length === 0 && header.lengthChange !== 0) {
      if (header.lengthChange > 0 && charBank.length > 0) {
        // 隐式插入
        operations.push({
          opcode: '+',
          chars: header.lengthChange,
          lines: charBank.split('\n').length - 1,
          attribs: ''
        });
      } else if (header.lengthChange < 0) {
        // 隐式删除
        operations.push({
          opcode: '-',
          chars: Math.abs(header.lengthChange),
          lines: 0,
          attribs: ''
        });
      }
    }
    
    // 处理仅有行指示符的情况（如"|1"）
    if (operations.length === 0 && opsStr.startsWith('|')) {
      const lineMatch = opsStr.match(/^\|([0-9a-z]+)$/);
      if (lineMatch && charBank.length > 0) {
        const lines = parseInt(lineMatch[1], 36);
        operations.push({
          opcode: '+',
          chars: charBank.length,
          lines: lines,
          attribs: ''
        });
      }
    }
    
    let currentPosition = 0;
    let charBankIndex = 0;
    const changes = [];
    let firstChangePosition = null;
    
    operations.forEach((op, opIndex) => {
      let content = '';
      let changeType = '';
      
      switch (op.opcode) {
        case '=':
          // 保持操作，不记录变更，但要移动位置指针
          currentPosition += op.chars;
          break;
          
        case '+':
          // 插入操作 - 位置是当前在原文档中的位置
          const insertPos = calculatePosition(currentPosition, baseDocument);
          content = charBank.substring(charBankIndex, charBankIndex + op.chars);
          changeType = '增加';
          
          // 记录第一个真实变更的位置
          if (!firstChangePosition) {
            firstChangePosition = `第${insertPos.line}行第${insertPos.wordIndex}个词`;
          }
          
          // 处理可见内容和不可见内容（换行符、空格等）
          if (content.trim()) {
            // 有可见内容
            changes.push({
              type: changeType,
              content: content,
              position: `第${insertPos.line}行第${insertPos.wordIndex}个词`,
              line: insertPos.line,
              wordIndex: insertPos.wordIndex
            });
          } else if (content.length > 0) {
            // 只有不可见字符（换行符、空格等）
            let invisibleDesc = '';
            if (content.includes('\n')) {
              invisibleDesc = '换行符';
            } else if (content === ' ') {
              invisibleDesc = '空格';
            } else {
              invisibleDesc = '不可见字符';
            }
            
            changes.push({
              type: changeType,
              content: invisibleDesc,
              position: `第${insertPos.line}行第${insertPos.wordIndex}个词`,
              line: insertPos.line,
              wordIndex: insertPos.wordIndex
            });
          } else if (op.chars > 0 && charBankIndex + op.chars > charBank.length) {
            // 特殊情况：charBank为空但要添加字符，通常是换行符
            let implicitContent = '';
            if (op.lines > 0) {
              implicitContent = `${op.lines}个换行符`;
            } else if (op.chars === 1) {
              implicitContent = '换行符或空格';
            } else {
              implicitContent = `${op.chars}个隐式字符`;
            }
            
            changes.push({
              type: changeType,
              content: implicitContent,
              position: `第${insertPos.line}行第${insertPos.wordIndex}个词`,
              line: insertPos.line,
              wordIndex: insertPos.wordIndex
            });
          }
          
          charBankIndex += op.chars;
          // 插入操作不移动原文档的位置指针
          break;
          
        case '-':
          // 删除操作 - 位置是要删除内容在原文档中的位置
          const deletePos = calculatePosition(currentPosition, baseDocument);
          content = baseDocument ? baseDocument.substring(currentPosition, currentPosition + op.chars) : `${op.chars}个字符`;
          changeType = '减少';
          
          // 记录第一个真实变更的位置
          if (!firstChangePosition) {
            firstChangePosition = `第${deletePos.line}行第${deletePos.wordIndex}个词`;
          }
          
          changes.push({
            type: changeType,
            content: content,
            position: `第${deletePos.line}行第${deletePos.wordIndex}个词`,
            line: deletePos.line,
            wordIndex: deletePos.wordIndex
          });
          
          // 删除操作要移动位置指针，跳过被删除的内容
          currentPosition += op.chars;
          break;
      }
    });
    
    // 如果没有检测到任何变更，但changeset不为空，可能是格式问题
    let primaryPosition = null;
    if (changes.length > 0) {
      primaryPosition = changes[0].position;
    } else if (firstChangePosition) {
      primaryPosition = firstChangePosition;
    } else if (header.lengthChange !== 0) {
      // 有长度变化但没有检测到具体变更，使用默认位置但指出问题
      primaryPosition = '第1行第1个词 (未能精确定位)';
    }
    
    return {
      changes,
      summary: formatChangesSummary(changes),
      lengthChange: header.lengthChange,
      change_description: formatChangesSummary(changes),
      change_position: primaryPosition
    };
    
  } catch (error) {
    console.error('解析changeset失败:', error);
    return {
      changes: [],
      summary: '解析失败',
      lengthChange: 0,
      change_description: '解析失败',
      change_position: null
    };
  }
}

// 格式化变更摘要
function formatChangesSummary(changes) {
  if (changes.length === 0) {
    return '无变更';
  }
  
  const summaryParts = [];
  
  changes.forEach(change => {
    if (change.content.trim()) {
      // 只显示变更类型和内容，不包含位置信息
      summaryParts.push(`${change.type} "${change.content}"`);
    }
  });
  
  return summaryParts.slice(0, 3).join('; ') + (summaryParts.length > 3 ? '...' : '');
}

// 提取pad信息
function extractPadInfo(storeKey) {
  const padMatch = storeKey.match(/^pad:(room-\d+):revs:(\d+)$/);
  if (padMatch) {
    return {
      padId: padMatch[1],
      revision: parseInt(padMatch[2])
    };
  }
  return null;
}

/**
 * 文档状态类 - 从content-reconstructor.js合并
 */
class DocumentState {
  constructor(text = '') {
    this.text = text;
  }

  // 应用changeset到当前文档状态
  applyChangeset(changeset) {
    try {
      // 使用简化的changeset应用逻辑
      const result = this.applyChangesetToText(changeset, this.text);
      this.text = result;
      return true;
    } catch (error) {
      console.warn(`⚠️  应用changeset失败: ${error.message}`);
      return false;
    }
  }

  // 简化的changeset应用实现
  applyChangesetToText(changeset, text) {
    const header = parseChangeset(changeset);
    const dollarIndex = changeset.indexOf('$');
    const opsEnd = dollarIndex >= 0 ? dollarIndex : changeset.length;
    const charBank = dollarIndex >= 0 ? changeset.slice(dollarIndex + 1) : '';
    const opsStr = changeset.slice(header.opsStart, opsEnd);
    const operations = parseOperations(opsStr);

    let result = '';
    let oldPos = 0;
    let bankPos = 0;

    for (const op of operations) {
      if (op.opcode === '=') {
        // 保持字符
        result += text.slice(oldPos, oldPos + op.chars);
        oldPos += op.chars;
      } else if (op.opcode === '+') {
        // 插入字符
        result += charBank.slice(bankPos, bankPos + op.chars);
        bankPos += op.chars;
      } else if (op.opcode === '-') {
        // 删除字符
        oldPos += op.chars;
      }
    }

    return result;
  }

  // 获取文档信息
  getInfo() {
    return {
      length: this.text.length,
      preview: this.text.substring(0, 100) + (this.text.length > 100 ? '...' : ''),
      lineCount: this.text.split('\n').length
    };
  }
}

/**
 * 内容重建器 - 从content-reconstructor.js合并并优化
 */
class ContentReconstructor {
  constructor() {
    this.documentStates = new Map(); // 存储每个版本的文档状态
  }

  /**
   * 重建pad内容
   * @param {Object} padData - pad数据，包含revisions数组
   * @returns {Map} 版本号到内容的映射
   */
  reconstructPadContent(padData) {
    const results = new Map();
    
    if (!padData || !padData.revisions || padData.revisions.length === 0) {
      return results;
    }

    // 按版本号排序
    const sortedRevisions = padData.revisions.sort((a, b) => a.revision - b.revision);
    
    // 初始化版本0
    let currentState = new DocumentState('');
    
    // 如果有版本0，使用其内容作为初始状态
    const version0 = sortedRevisions.find(r => r.revision === 0);
    if (version0 && version0.content !== undefined) {
      currentState = new DocumentState(version0.content);
      results.set(0, {
        content: version0.content,
        length: version0.content.length,
        error: null
      });
    } else {
      // 没有版本0，使用空文档
      results.set(0, {
        content: '',
        length: 0,
        error: null
      });
    }

    // 处理其他版本
    for (const revision of sortedRevisions) {
      if (revision.revision === 0) continue; // 版本0已处理
      
      try {
        if (revision.changeset && revision.changeset.trim() !== '') {
          const success = currentState.applyChangeset(revision.changeset);
          if (success) {
            results.set(revision.revision, {
              content: currentState.text,
              length: currentState.text.length,
              error: null
            });
          } else {
            results.set(revision.revision, {
              content: null,
              length: 0,
              error: 'Changeset应用失败'
            });
          }
        } else {
          // 没有changeset，保持当前状态
          results.set(revision.revision, {
            content: currentState.text,
            length: currentState.text.length,
            error: null
          });
        }
      } catch (error) {
        console.warn(`⚠️  重建版本${revision.revision}失败:`, error.message);
        results.set(revision.revision, {
          content: null,
          length: 0,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * 从数据库记录重建内容（保持向后兼容）
   * @param {Array} revisions - 版本记录数组
   * @param {string} initialContent - 初始内容
   * @returns {Map} 版本号到内容的映射
   */
  reconstructFromDBRecords(revisions, initialContent = '') {
    const padData = { revisions };
    return this.reconstructPadContent(padData);
  }
}

module.exports = {
  parseNum,
  parseChangeset,
  parseOperations,
  analyzeChangesetContent,
  calculatePosition,
  countWordsInLine,
  extractPadInfo, // 导出pad信息提取函数
  ContentReconstructor, // 导出合并后的内容重建器
  DocumentState // 导出文档状态类
}; 