/**
 * 句子分割器 - Node.js 包装器
 * 
 * 使用 Python NLTK 进行句子分割
 * 通过 python-shell 与 Python 进程通信
 */

const { PythonShell } = require('python-shell');
const path = require('path');

class SentenceSplitter {
  constructor() {
    this.pythonShell = null;
    this.scriptPath = path.join(__dirname, 'sentence_splitter.py');
    this.isInitialized = false;
    this.pendingCallbacks = new Map();
    this.callbackId = 0;
  }

  /**
   * 初始化 Python Shell
   */
  init() {
    if (this.isInitialized) {
      return;
    }

    const options = {
      mode: 'json',
      // Windows 上使用 'py'，Linux/macOS 使用 'python3'
      pythonPath: process.env.PYTHON_PATH || (process.platform === 'win32' ? 'py' : 'python3'),
      pythonOptions: ['-u'], // unbuffered
      scriptPath: __dirname,
      args: []
    };

    try {
      this.pythonShell = new PythonShell('sentence_splitter.py', options);
      
      // 监听消息
      this.pythonShell.on('message', (result) => {
        this._handleMessage(result);
      });

      // 监听错误
      this.pythonShell.on('error', (error) => {
        console.error('[SentenceSplitter] Python error:', error);
        // 触发所有待处理的回调
        this.pendingCallbacks.forEach((callback) => {
          callback.reject(error);
        });
        this.pendingCallbacks.clear();
      });

      // 监听关闭
      this.pythonShell.on('close', () => {
        console.log('[SentenceSplitter] Python process closed');
        this.isInitialized = false;
        this.pythonShell = null;
      });

      this.isInitialized = true;
      console.log('[SentenceSplitter] Initialized successfully');
    } catch (error) {
      console.error('[SentenceSplitter] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * 处理来自 Python 的消息
   */
  _handleMessage(result) {
    // 由于我们使用单线程顺序处理，使用 FIFO 队列
    const callbacks = Array.from(this.pendingCallbacks.values());
    if (callbacks.length === 0) {
      console.warn('[SentenceSplitter] Received message but no pending callbacks');
      return;
    }

    const callback = callbacks[0];
    const key = Array.from(this.pendingCallbacks.keys())[0];
    this.pendingCallbacks.delete(key);

    if (result.success) {
      callback.resolve(result.count);
    } else {
      callback.reject(new Error(result.error || 'Unknown error'));
    }
  }

  /**
   * 统计文本中的句子数量
   * 
   * @param {string} text - 要分析的文本
   * @returns {Promise<number>} 句子数量
   */
  async countSentences(text) {
    // 空文本直接返回 0
    if (!text || !text.trim()) {
      return 0;
    }

    // 确保已初始化
    if (!this.isInitialized) {
      this.init();
    }

    return new Promise((resolve, reject) => {
      const id = this.callbackId++;
      
      // 保存回调
      this.pendingCallbacks.set(id, { resolve, reject });

      try {
        // 发送消息到 Python
        const message = { text: text };
        this.pythonShell.send(message);
      } catch (error) {
        this.pendingCallbacks.delete(id);
        reject(error);
      }
    });
  }

  /**
   * 批量统计句子数量
   * 
   * @param {string[]} texts - 文本数组
   * @returns {Promise<number[]>} 句子数量数组
   */
  async countSentencesBatch(texts) {
    const results = [];
    
    for (const text of texts) {
      const count = await this.countSentences(text);
      results.push(count);
    }
    
    return results;
  }

  /**
   * 关闭 Python 进程
   */
  close() {
    if (this.pythonShell) {
      try {
        this.pythonShell.end((err) => {
          if (err) {
            console.error('[SentenceSplitter] Error closing Python shell:', err);
          }
        });
      } catch (error) {
        console.error('[SentenceSplitter] Error closing Python shell:', error);
      }
      this.pythonShell = null;
      this.isInitialized = false;
      this.pendingCallbacks.clear();
    }
  }
}

module.exports = SentenceSplitter;

