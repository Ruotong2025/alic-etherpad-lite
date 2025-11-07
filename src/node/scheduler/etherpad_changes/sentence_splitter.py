#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
句子分割器（基于 jieba 和 NLTK）
用于判断文本中的句子数量，支持中英文混合文本
"""

import sys
import json
import nltk
import os
import logging
import io

# 设置标准输入输出的编码为 UTF-8
if sys.platform == 'win32':
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# 先导入 jieba，然后禁用日志
import jieba
jieba.setLogLevel(logging.ERROR)

# 确保 NLTK 数据已下载
def ensure_nltk_data():
    """确保必要的 NLTK 数据已下载"""
    # 尝试多个数据包，优先使用新版本
    packages_to_try = ['punkt_tab', 'punkt']
    
    for package in packages_to_try:
        try:
            # 尝试查找数据包
            if package == 'punkt_tab':
                nltk.data.find('tokenizers/punkt_tab')
            else:
                nltk.data.find('tokenizers/punkt')
            # 如果找到，直接返回
            return
        except LookupError:
            # 数据包不存在，尝试下载
            try:
                print(json.dumps({'info': f'Downloading NLTK {package} tokenizer...'}), file=sys.stderr, flush=True)
                nltk.download(package, quiet=True)
                return
            except Exception as e:
                # 下载失败，尝试下一个
                print(json.dumps({'warning': f'Failed to download {package}: {str(e)}'}), file=sys.stderr, flush=True)
                continue
    
    # 如果所有尝试都失败，记录错误
    print(json.dumps({'error': 'Failed to download any NLTK tokenizer data'}), file=sys.stderr, flush=True)

def split_sentences_with_jieba(text):
    """
    使用 jieba 分词后进行句子分割
    
    改进逻辑：
    1. 将中文标点替换为英文标点（让 NLTK 能识别）
    2. 使用 jieba.lcut 进行分词
    3. 连接为字符串（词之间加空格）
    4. 使用 NLTK 的 sent_tokenize 进行句子分割
    
    Args:
        text (str): 要分析的文本
    
    Returns:
        list: 句子列表
    """
    if not text or not text.strip():
        return []
    
    # 将中文标点替换为英文标点，让 NLTK 能正确识别句子边界
    text_converted = text
    text_converted = text_converted.replace('。', '.')
    text_converted = text_converted.replace('！', '!')
    text_converted = text_converted.replace('？', '?')
    text_converted = text_converted.replace('；', ';')
    
    # 使用 jieba 进行分词
    seg_list = jieba.lcut(text_converted)
    
    # 连接为字符串（在词之间加空格）
    seg_text = " ".join(seg_list)
    
    # 使用 NLTK 的 sent_tokenize 进行句子分割
    sentences = nltk.tokenize.sent_tokenize(seg_text)
    
    return sentences

def count_sentences_enhanced(text):
    """
    增强版分句：只有中文才使用 jieba + NLTK，纯英文直接使用 NLTK
    
    Args:
        text (str): 要分析的文本
    
    Returns:
        int: 句子数量
    """
    import re
    
    if not text or not text.strip():
        return 0
    
    try:
        # 检查是否包含中文字符
        has_chinese = bool(re.search(r'[\u4e00-\u9fff]', text))
        
        if has_chinese:
            # 包含中文，使用 jieba + NLTK 分句
            sentences = split_sentences_with_jieba(text)
        else:
            # 纯英文，直接使用 NLTK 分句
            # 转换中文标点为英文标点，便于 NLTK 识别
            text_converted = text.replace('。', '.').replace('！', '!').replace('？', '?').replace('；', ';')
            sentences = nltk.tokenize.sent_tokenize(text_converted)
        
        non_empty_sentences = [s for s in sentences if s.strip()]
        return len(non_empty_sentences)
    except Exception as e:
        # 如果分句失败，回退到简单计数
        # 至少返回 1（表示有内容）
        return 1

def count_sentences(text):
    """
    使用 NLTK 对文本进行分句并返回句子数量
    
    Args:
        text (str): 要分析的文本
    
    Returns:
        int: 句子数量
    """
    if not text or not text.strip():
        return 0
    
    try:
        # 使用增强版分句
        return count_sentences_enhanced(text)
    except Exception as e:
        # 如果分句失败，返回错误
        raise Exception(f"Sentence tokenization failed: {str(e)}")

def process_request(data):
    """
    处理单个请求
    
    Args:
        data (dict): 包含 'text' 字段的字典
    
    Returns:
        dict: 包含 'count' 和 'success' 字段的结果
    """
    try:
        text = data.get('text', '')
        count = count_sentences(text)
        
        return {
            'count': count,
            'success': True
        }
    except Exception as e:
        return {
            'error': str(e),
            'success': False
        }

def main():
    """主函数：从标准输入读取 JSON，处理后输出结果"""
    # 确保 NLTK 数据已下载
    ensure_nltk_data()
    
    # 持续从标准输入读取数据
    for line in sys.stdin:
        try:
            # 解析输入的 JSON
            data = json.loads(line.strip())
            
            # 处理请求
            result = process_request(data)
            
            # 输出结果
            print(json.dumps(result, ensure_ascii=False))
            sys.stdout.flush()
        except json.JSONDecodeError as e:
            # JSON 解析错误
            error_result = {
                'error': f'Invalid JSON: {str(e)}',
                'success': False
            }
            print(json.dumps(error_result, ensure_ascii=False))
            sys.stdout.flush()
        except Exception as e:
            # 其他错误
            error_result = {
                'error': f'Unexpected error: {str(e)}',
                'success': False
            }
            print(json.dumps(error_result, ensure_ascii=False))
            sys.stdout.flush()

if __name__ == '__main__':
    main()

