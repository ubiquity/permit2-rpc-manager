export type Priority = 'low' | 'normal' | 'high' | 'critical';

export interface QueuedRequest<T = any> {
  id: string;
  request: () => Promise<T>;
  priority: Priority;
  timestamp: number;
  retryCount: number;
  maxRetries: number;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout?: number;
  metadata?: Record<string, any>;
}

export interface QueueConfig {
  maxQueueSize?: number;
  processBatchSize?: number;
  processIntervalMs?: number;
  maxConcurrentRequests?: number;
  defaultTimeout?: number;
  enableBackpressure?: boolean;
  backpressureThreshold?: number;
}

export interface QueueStats {
  queueLength: number;
  processing: number;
  completed: number;
  failed: number;
  avgWaitTime: number;
  avgProcessTime: number;
  backpressureActive: boolean;
}

export class RequestQueue {
  private queue: QueuedRequest[] = [];
  private processing = new Set<string>();
  private processingPromises = new Map<string, Promise<any>>();
  
  private readonly MAX_QUEUE_SIZE: number;
  private readonly PROCESS_BATCH_SIZE: number;
  private readonly PROCESS_INTERVAL_MS: number;
  private readonly MAX_CONCURRENT_REQUESTS: number;
  private readonly DEFAULT_TIMEOUT: number;
  private readonly ENABLE_BACKPRESSURE: boolean;
  private readonly BACKPRESSURE_THRESHOLD: number;
  
  private isProcessing = false;
  private processTimer?: any;
  
  // Statistics
  private stats = {
    completed: 0,
    failed: 0,
    totalWaitTime: 0,
    totalProcessTime: 0,
    droppedRequests: 0
  };
  
  // Priority weights for sorting
  private readonly PRIORITY_WEIGHTS: Record<Priority, number> = {
    critical: 1000,
    high: 100,
    normal: 10,
    low: 1
  };
  
  constructor(config: QueueConfig = {}) {
    this.MAX_QUEUE_SIZE = config.maxQueueSize ?? 1000;
    this.PROCESS_BATCH_SIZE = config.processBatchSize ?? 10;
    this.PROCESS_INTERVAL_MS = config.processIntervalMs ?? 100;
    this.MAX_CONCURRENT_REQUESTS = config.maxConcurrentRequests ?? 20;
    this.DEFAULT_TIMEOUT = config.defaultTimeout ?? 30000;
    this.ENABLE_BACKPRESSURE = config.enableBackpressure ?? true;
    this.BACKPRESSURE_THRESHOLD = config.backpressureThreshold ?? 0.8;
  }
  
  /**
   * Add request to queue
   */
  enqueue<T>(
    request: () => Promise<T>,
    options: {
      priority?: Priority;
      timeout?: number;
      maxRetries?: number;
      metadata?: Record<string, any>;
    } = {}
  ): Promise<T> {
    // Check backpressure
    if (this.isBackpressureActive()) {
      throw new Error(
        'Service temporarily overloaded. Queue is at capacity. Please retry in a few moments.'
      );
    }
    
    // Check queue size
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      this.stats.droppedRequests++;
      
      if (this.ENABLE_BACKPRESSURE) {
        throw new Error(
          `Request queue full (${this.MAX_QUEUE_SIZE} items). Service is experiencing high load.`
        );
      } else {
        // Drop oldest low-priority request to make room
        this.dropOldestLowPriorityRequest();
      }
    }
    
    return new Promise<T>((resolve, reject) => {
      const queuedRequest: QueuedRequest<T> = {
        id: this.generateRequestId(),
        request,
        priority: options.priority ?? 'normal',
        timestamp: Date.now(),
        retryCount: 0,
        maxRetries: options.maxRetries ?? 3,
        resolve,
        reject,
        timeout: options.timeout ?? this.DEFAULT_TIMEOUT,
        metadata: options.metadata
      };
      
      // Add to queue based on priority
      this.insertByPriority(queuedRequest);
      
      // Start processing if not already running
      if (!this.isProcessing) {
        this.startProcessing();
      }
    });
  }
  
  /**
   * Insert request into queue based on priority
   */
  private insertByPriority(request: QueuedRequest): void {
    const score = this.calculatePriorityScore(request);
    
    // Find insertion point
    let insertIndex = this.queue.length;
    
    for (let i = 0; i < this.queue.length; i++) {
      const existingScore = this.calculatePriorityScore(this.queue[i]);
      
      if (score > existingScore) {
        insertIndex = i;
        break;
      }
    }
    
    // Insert at calculated position
    this.queue.splice(insertIndex, 0, request);
  }
  
  /**
   * Calculate priority score for sorting
   */
  private calculatePriorityScore(request: QueuedRequest): number {
    const priorityWeight = this.PRIORITY_WEIGHTS[request.priority];
    const ageBonus = (Date.now() - request.timestamp) / 1000; // Bonus for waiting
    
    return priorityWeight + ageBonus;
  }
  
  /**
   * Start queue processing
   */
  private startProcessing(): void {
    if (this.isProcessing) return;
    
    this.isProcessing = true;
    this.processQueue();
  }
  
  /**
   * Stop queue processing
   */
  stopProcessing(): void {
    this.isProcessing = false;
    
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = undefined;
    }
  }
  
  /**
   * Process queued requests
   */
  private async processQueue(): Promise<void> {
    while (this.isProcessing && this.queue.length > 0) {
      // Wait if at max concurrent requests
      while (this.processing.size >= this.MAX_CONCURRENT_REQUESTS) {
        await this.waitForCapacity();
      }
      
      // Get batch of requests to process
      const batch = this.queue.splice(0, 
        Math.min(this.PROCESS_BATCH_SIZE, this.MAX_CONCURRENT_REQUESTS - this.processing.size)
      );
      
      // Process batch concurrently
      const promises = batch.map(req => this.processRequest(req));
      
      // Don't wait for completion, let them run async
      Promise.all(promises).catch(() => {
        // Errors are handled in processRequest
      });
      
      // Small delay between batches to prevent overwhelming
      if (this.queue.length > 0) {
        await this.delay(this.PROCESS_INTERVAL_MS);
      }
    }
    
    this.isProcessing = false;
  }
  
  /**
   * Process individual request
   */
  private async processRequest<T>(queuedRequest: QueuedRequest<T>): Promise<void> {
    const waitTime = Date.now() - queuedRequest.timestamp;
    this.stats.totalWaitTime += waitTime;
    
    this.processing.add(queuedRequest.id);
    const startTime = Date.now();
    
    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Request timeout after ${queuedRequest.timeout}ms`));
      }, queuedRequest.timeout!);
    });
    
    try {
      // Race between request and timeout
      const result = await Promise.race([
        queuedRequest.request(),
        timeoutPromise
      ]);
      
      // Success
      this.stats.completed++;
      this.stats.totalProcessTime += Date.now() - startTime;
      
      queuedRequest.resolve(result as T);
      
    } catch (error: any) {
      // Check if we should retry
      if (queuedRequest.retryCount < queuedRequest.maxRetries) {
        queuedRequest.retryCount++;
        
        // Re-queue with higher priority
        const newPriority = this.escalatePriority(queuedRequest.priority);
        queuedRequest.priority = newPriority;
        queuedRequest.timestamp = Date.now(); // Reset timestamp for age calculation
        
        this.insertByPriority(queuedRequest);
        
      } else {
        // Max retries reached
        this.stats.failed++;
        queuedRequest.reject(error);
      }
      
    } finally {
      this.processing.delete(queuedRequest.id);
      this.processingPromises.delete(queuedRequest.id);
    }
  }
  
  /**
   * Wait for processing capacity
   */
  private async waitForCapacity(): Promise<void> {
    if (this.processing.size === 0) return;
    
    // Wait for any request to complete
    const promises = Array.from(this.processingPromises.values());
    if (promises.length > 0) {
      await Promise.race(promises).catch(() => {
        // Ignore errors, just waiting for capacity
      });
    } else {
      // Fallback delay
      await this.delay(100);
    }
  }
  
  /**
   * Check if backpressure should be applied
   */
  private isBackpressureActive(): boolean {
    if (!this.ENABLE_BACKPRESSURE) return false;
    
    const utilization = this.queue.length / this.MAX_QUEUE_SIZE;
    return utilization >= this.BACKPRESSURE_THRESHOLD;
  }
  
  /**
   * Drop oldest low-priority request
   */
  private dropOldestLowPriorityRequest(): void {
    // Find oldest low priority request
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].priority === 'low') {
        const dropped = this.queue.splice(i, 1)[0];
        dropped.reject(new Error('Request dropped due to queue overflow'));
        this.stats.droppedRequests++;
        return;
      }
    }
    
    // If no low priority, drop oldest normal
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].priority === 'normal') {
        const dropped = this.queue.splice(i, 1)[0];
        dropped.reject(new Error('Request dropped due to queue overflow'));
        this.stats.droppedRequests++;
        return;
      }
    }
  }
  
  /**
   * Escalate priority for retry
   */
  private escalatePriority(current: Priority): Priority {
    switch (current) {
      case 'low':
        return 'normal';
      case 'normal':
        return 'high';
      case 'high':
      case 'critical':
        return 'critical';
      default:
        return 'normal';
    }
  }
  
  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Get queue statistics
   */
  getStats(): QueueStats {
    const avgWaitTime = this.stats.completed > 0 
      ? this.stats.totalWaitTime / this.stats.completed 
      : 0;
      
    const avgProcessTime = this.stats.completed > 0
      ? this.stats.totalProcessTime / this.stats.completed
      : 0;
    
    return {
      queueLength: this.queue.length,
      processing: this.processing.size,
      completed: this.stats.completed,
      failed: this.stats.failed,
      avgWaitTime,
      avgProcessTime,
      backpressureActive: this.isBackpressureActive()
    };
  }
  
  /**
   * Clear the queue
   */
  clear(): void {
    // Reject all queued requests
    for (const request of this.queue) {
      request.reject(new Error('Queue cleared'));
    }
    
    this.queue = [];
  }
  
  /**
   * Get queue length by priority
   */
  getQueueLengthByPriority(): Record<Priority, number> {
    const counts: Record<Priority, number> = {
      critical: 0,
      high: 0,
      normal: 0,
      low: 0
    };
    
    for (const request of this.queue) {
      counts[request.priority]++;
    }
    
    return counts;
  }
}