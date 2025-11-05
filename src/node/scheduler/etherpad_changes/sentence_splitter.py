#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NLTK 句子分割器
用于判断文本中的句子数量，支持中英文混合文本
"""

import sys
import json
import nltk
import os

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

def count_sentences_enhanced(text):
    """
    增强版分句：先使用中文标点分句，再用 NLTK 验证
    
    Args:
        text (str): 要分析的文本
    
    Returns:
        int: 句子数量
    """
    import re
    
    if not text or not text.strip():
        return 0
    
    # 方法1：基于中文标点的快速分句
    # 中文句子结束符：。！？；\n
    chinese_sentence_pattern = r'[。！？；\n]+'
    chinese_sentences = re.split(chinese_sentence_pattern, text.strip())
    chinese_sentences = [s.strip() for s in chinese_sentences if s.strip()]
    
    # 如果包含中文字符且中文分句结果 > 1，使用中文分句结果
    if re.search(r'[\u4e00-\u9fff]', text) and len(chinese_sentences) > 1:
        return len(chinese_sentences)
    
    # 方法2：使用 NLTK（主要用于英文）
    try:
        sentences = nltk.sent_tokenize(text.strip())
        non_empty_sentences = [s for s in sentences if s.strip()]
        
        # 返回两种方法中较大的值（更保守）
        return max(len(non_empty_sentences), len(chinese_sentences))
    except Exception as e:
        # NLTK 失败时，回退到中文分句结果
        return len(chinese_sentences) if chinese_sentences else 1

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

