/**
 * Etherpad集成定时任务调度器
 * 基于node-cron实现，集成到Etherpad主应用
 * 替代独立的cron-setup.sh脚本
 */

import cron from 'node-cron';
import log4js from 'log4js';
import path from 'path';
import fs from 'fs/promises';
import { fork } from 'child_process';

const logger = log4js.getLogger('scheduler');

interface TaskConfig {
  cron: string;
  command: string;
  description: string;
  target_table: string;
  priority: number;
  estimated_duration: string;
  log_file: string;
  enabled?: boolean;
}

interface SchedulerConfig {
  enabled: boolean;
  timezone: string;
  task_schedules: {
    [key: string]: TaskConfig;
  };
  execution_flow?: {
    sequence: Array<{
      step: number;
      time: string;
      task: string;
      purpose: string;
    }>;
  };
}

export class TaskScheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private config: SchedulerConfig | null = null;
  private configPath: string;
  private processorPath: string;
  private logDir: string;
  private isRunning: boolean = false;

  constructor() {
    // 当前文件在: src/node/scheduler/TaskScheduler.ts
    // __dirname 在运行时会指向: D:\ALIC\alic-etherpad-lite\src\node\scheduler
    // 因此可以直接使用相对路径构建配置文件路径
    this.configPath = path.join(__dirname, 'cron-config.json');
    this.processorPath = path.join(__dirname, 'etherpad-processor.js');
    // 日志目录在项目根目录下的 logs 文件夹
    this.logDir = path.join(__dirname, '../../..', 'logs');
  }

  /**
   * 初始化调度器
   */
  async initialize(): Promise<void> {
    try {
      logger.info('🚀 初始化Etherpad定时任务调度器...');

      // 创建日志目录
      await this.ensureLogDirectory();

      // 加载配置
      await this.loadConfig();

      if (!this.config?.enabled) {
        logger.info('⏸️  定时任务调度器已禁用（在配置文件中设置）');
        return;
      }

      // 注册所有任务
      this.registerTasks();

      // 启动所有任务
      this.startAll();

      logger.info('✅ 定时任务调度器初始化完成');
      this.logScheduledTasks();

    } catch (error) {
      logger.error('❌ 定时任务调度器初始化失败:', error);
      throw error;
    }
  }

  /**
   * 确保日志目录存在
   */
  private async ensureLogDirectory(): Promise<void> {
    try {
      await fs.access(this.logDir);
    } catch {
      await fs.mkdir(this.logDir, { recursive: true });
      logger.info(`📂 创建日志目录: ${this.logDir}`);
    }
  }

  /**
   * 加载配置文件
   */
  private async loadConfig(): Promise<void> {
    try {
      const configData = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(configData) as SchedulerConfig;
      
      // 如果配置中没有enabled字段，默认启用
      if (this.config.enabled === undefined) {
        this.config.enabled = true;
      }

      logger.info(`📋 加载配置文件: ${this.configPath}`);
      logger.info(`🌏 时区: ${this.config.timezone || 'Asia/Shanghai'}`);
      logger.info(`📊 配置任务数: ${Object.keys(this.config.task_schedules).length}`);
    } catch (error) {
      logger.error('❌ 配置文件加载失败:', error);
      throw error;
    }
  }

  /**
   * 注册所有定时任务
   */
  private registerTasks(): void {
    if (!this.config) return;

    const tasks = Object.entries(this.config.task_schedules);
    
    // 按优先级排序
    tasks.sort(([, a], [, b]) => a.priority - b.priority);

    for (const [taskName, taskConfig] of tasks) {
      if (taskConfig.enabled === false) {
        logger.info(`⏭️  跳过禁用的任务: ${taskName}`);
        continue;
      }

      this.registerTask(taskName, taskConfig);
    }
  }

  /**
   * 注册单个定时任务
   */
  private registerTask(taskName: string, taskConfig: TaskConfig): void {
    try {
      const task = cron.schedule(
        taskConfig.cron,
        () => this.executeTask(taskName, taskConfig),
        {
          scheduled: false, // 先不启动，等待手动启动
          timezone: this.config?.timezone || 'Asia/Shanghai'
        }
      );

      this.tasks.set(taskName, task);
      
      logger.info(`✅ 注册任务: ${taskName}`);
      logger.info(`   ├─ 描述: ${taskConfig.description}`);
      logger.info(`   ├─ Cron: ${taskConfig.cron}`);
      logger.info(`   ├─ 目标表: ${taskConfig.target_table}`);
      logger.info(`   ├─ 优先级: ${taskConfig.priority}`);
      logger.info(`   └─ 预计耗时: ${taskConfig.estimated_duration}`);

    } catch (error) {
      logger.error(`❌ 注册任务失败 [${taskName}]:`, error);
    }
  }

  /**
   * 执行定时任务
   */
  private async executeTask(taskName: string, taskConfig: TaskConfig): Promise<void> {
    const startTime = Date.now();
    const logFile = path.join(this.logDir, taskConfig.log_file);

    logger.info(`▶️  开始执行任务: ${taskName}`);
    logger.info(`   时间: ${new Date().toLocaleString('zh-CN', { timeZone: this.config?.timezone || 'Asia/Shanghai' })}`);

    try {
      // 使用子进程执行处理器脚本
      const child = fork(
        this.processorPath,
        [taskConfig.command],
        {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: {
            ...process.env,
            TASK_NAME: taskName,
            LOG_FILE: logFile
          }
        }
      );

      // 将子进程输出写入日志文件
      const logStream = await fs.open(logFile, 'a');
      const logWriter = logStream.createWriteStream();

      const timestamp = new Date().toISOString();
      logWriter.write(`\n${'='.repeat(80)}\n`);
      logWriter.write(`[${timestamp}] 开始执行任务: ${taskName}\n`);
      logWriter.write(`描述: ${taskConfig.description}\n`);
      logWriter.write(`目标表: ${taskConfig.target_table}\n`);
      logWriter.write(`${'='.repeat(80)}\n\n`);

      child.stdout?.pipe(logWriter);
      child.stderr?.pipe(logWriter);

      // 等待子进程完成
      await new Promise<void>((resolve, reject) => {
        child.on('exit', (code) => {
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          
          if (code === 0) {
            logger.info(`✅ 任务完成: ${taskName} (耗时: ${duration}s)`);
            logWriter.write(`\n[${new Date().toISOString()}] 任务成功完成 (耗时: ${duration}s)\n`);
            resolve();
          } else {
            logger.error(`❌ 任务失败: ${taskName} (退出码: ${code}, 耗时: ${duration}s)`);
            logWriter.write(`\n[${new Date().toISOString()}] 任务失败 (退出码: ${code}, 耗时: ${duration}s)\n`);
            reject(new Error(`Task failed with code ${code}`));
          }
          
          logWriter.end();
          logStream.close();
        });

        child.on('error', (error) => {
          logger.error(`❌ 任务执行错误: ${taskName}`, error);
          logWriter.write(`\n[${new Date().toISOString()}] 执行错误: ${error.message}\n`);
          logWriter.end();
          logStream.close();
          reject(error);
        });
      });

    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.error(`❌ 任务执行异常: ${taskName} (耗时: ${duration}s)`, error);
    }
  }

  /**
   * 启动所有任务
   */
  startAll(): void {
    if (this.isRunning) {
      logger.warn('⚠️  调度器已在运行中');
      return;
    }

    let startedCount = 0;
    for (const [taskName, task] of this.tasks.entries()) {
      task.start();
      startedCount++;
      logger.info(`▶️  启动任务: ${taskName}`);
    }

    this.isRunning = true;
    logger.info(`✅ 已启动 ${startedCount} 个定时任务`);
  }

  /**
   * 停止所有任务
   */
  stopAll(): void {
    if (!this.isRunning) {
      logger.warn('⚠️  调度器未运行');
      return;
    }

    let stoppedCount = 0;
    for (const [taskName, task] of this.tasks.entries()) {
      task.stop();
      stoppedCount++;
      logger.info(`⏸️  停止任务: ${taskName}`);
    }

    this.isRunning = false;
    logger.info(`✅ 已停止 ${stoppedCount} 个定时任务`);
  }

  /**
   * 手动执行指定任务
   */
  async runTask(taskName: string): Promise<void> {
    if (!this.config) {
      throw new Error('配置未加载');
    }

    const taskConfig = this.config.task_schedules[taskName];
    if (!taskConfig) {
      throw new Error(`任务不存在: ${taskName}`);
    }

    logger.info(`🔧 手动执行任务: ${taskName}`);
    await this.executeTask(taskName, taskConfig);
  }

  /**
   * 获取任务状态
   */
  getStatus(): { isRunning: boolean; tasks: Array<{ name: string; nextRun: string }> } {
    const taskList = Array.from(this.tasks.entries()).map(([name, task]) => ({
      name,
      nextRun: 'N/A' // node-cron没有直接获取下次运行时间的方法
    }));

    return {
      isRunning: this.isRunning,
      tasks: taskList
    };
  }

  /**
   * 记录已调度的任务信息
   */
  private logScheduledTasks(): void {
    if (!this.config) return;

    logger.info('📋 已调度的任务列表:');
    logger.info('─'.repeat(80));

    const tasks = Object.entries(this.config.task_schedules);
    tasks.sort(([, a], [, b]) => a.priority - b.priority);

    for (const [taskName, taskConfig] of tasks) {
      if (taskConfig.enabled === false) continue;

      logger.info(`📌 ${taskName}`);
      logger.info(`   │ 描述: ${taskConfig.description}`);
      logger.info(`   │ Cron: ${taskConfig.cron}`);
      logger.info(`   │ 目标: ${taskConfig.target_table}`);
      logger.info(`   │ 优先级: ${taskConfig.priority}`);
      logger.info(`   │ 预计耗时: ${taskConfig.estimated_duration}`);
      logger.info(`   └─ 日志: ${path.join(this.logDir, taskConfig.log_file)}`);
      logger.info('');
    }

    if (this.config.execution_flow?.sequence) {
      logger.info('🔄 执行流程:');
      for (const step of this.config.execution_flow.sequence) {
        logger.info(`   ${step.step}. ${step.time} - ${step.task}`);
        logger.info(`      ${step.purpose}`);
      }
    }

    logger.info('─'.repeat(80));
  }

  /**
   * 销毁调度器
   */
  async destroy(): Promise<void> {
    logger.info('🛑 正在关闭定时任务调度器...');
    this.stopAll();
    this.tasks.clear();
    logger.info('✅ 定时任务调度器已关闭');
  }
}

// 导出单例
export const taskScheduler = new TaskScheduler();

