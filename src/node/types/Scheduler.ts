/**
 * 定时任务调度器类型定义
 */

export interface TaskConfig {
  cron: string;
  command: string;
  description: string;
  target_table: string;
  priority: number;
  estimated_duration: string;
  log_file: string;
  enabled?: boolean;
}

export interface SchedulerConfig {
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

export interface TaskStatus {
  name: string;
  nextRun: string;
  lastRun?: Date;
  status?: 'pending' | 'running' | 'completed' | 'failed';
}

export interface SchedulerStatus {
  isRunning: boolean;
  tasks: TaskStatus[];
}


