export interface ConnectionStats {
  activeConnections: number;
  idleConnections: number;
  totalRequests: number;
  avgResponseTime: number;
  lastUsed: number;
  errors: number;
}

export interface PoolConfig {
  maxSockets?: number;
  maxFreeSockets?: number;
  keepAliveTimeout?: number;
  socketTimeout?: number;
  maxRetries?: number;
}

export class ConnectionPool {
  private readonly DEFAULT_MAX_SOCKETS = 10;
  private readonly DEFAULT_MAX_FREE_SOCKETS = 2;
  private readonly DEFAULT_KEEP_ALIVE_TIMEOUT = 60000; // 1 minute
  private readonly DEFAULT_SOCKET_TIMEOUT = 30000; // 30 seconds
  
  private connectionStats = new Map<string, ConnectionStats>();
  private activeRequests = new Map<string, Set<string>>(); // rpcUrl -> Set of request IDs
  private config: Required<PoolConfig>;
  
  constructor(config: PoolConfig = {}) {
    this.config = {
      maxSockets: config.maxSockets ?? this.DEFAULT_MAX_SOCKETS,
      maxFreeSockets: config.maxFreeSockets ?? this.DEFAULT_MAX_FREE_SOCKETS,
      keepAliveTimeout: config.keepAliveTimeout ?? this.DEFAULT_KEEP_ALIVE_TIMEOUT,
      socketTimeout: config.socketTimeout ?? this.DEFAULT_SOCKET_TIMEOUT,
      maxRetries: config.maxRetries ?? 3
    };
  }
  
  /**
   * Execute a request with connection pooling
   */
  async executeWithPool<T>(
    rpcUrl: string,
    request: any,
    options: RequestInit = {}
  ): Promise<T> {
    const requestId = this.generateRequestId();
    const stats = this.getOrCreateStats(rpcUrl);
    
    // Check if we've reached connection limit
    if (!this.canCreateConnection(rpcUrl)) {
      // Wait for a connection to become available
      await this.waitForAvailableConnection(rpcUrl);
    }
    
    // Track active request
    this.trackRequest(rpcUrl, requestId);
    stats.activeConnections++;
    stats.totalRequests++;
    
    const startTime = Date.now();
    
    try {
      // Configure fetch options for connection reuse
      const fetchOptions: RequestInit = {
        ...options,
        keepalive: true,
        signal: this.createTimeoutSignal(),
        headers: {
          'Content-Type': 'application/json',
          'Connection': 'keep-alive',
          'Keep-Alive': `timeout=${Math.floor(this.config.keepAliveTimeout / 1000)}`,
          ...options.headers
        }
      };
      
      // Add request body if provided
      if (request) {
        fetchOptions.method = 'POST';
        fetchOptions.body = JSON.stringify(request);
      }
      
      const response = await fetch(rpcUrl, fetchOptions);
      
      // Update statistics
      const responseTime = Date.now() - startTime;
      this.updateResponseTime(stats, responseTime);
      stats.lastUsed = Date.now();
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      return data as T;
      
    } catch (error) {
      stats.errors++;
      throw error;
      
    } finally {
      // Clean up tracking
      this.untrackRequest(rpcUrl, requestId);
      stats.activeConnections--;
      
      // Move to idle if no active requests
      if (stats.activeConnections === 0) {
        stats.idleConnections = Math.min(this.config.maxFreeSockets, stats.idleConnections + 1);
      }
    }
  }
  
  /**
   * Check if we can create a new connection
   */
  private canCreateConnection(rpcUrl: string): boolean {
    const stats = this.getOrCreateStats(rpcUrl);
    return stats.activeConnections < this.config.maxSockets;
  }
  
  /**
   * Wait for an available connection slot
   */
  private async waitForAvailableConnection(rpcUrl: string): Promise<void> {
    const checkInterval = 100; // Check every 100ms
    const maxWait = 5000; // Max 5 seconds wait
    const startTime = Date.now();
    
    while (!this.canCreateConnection(rpcUrl)) {
      if (Date.now() - startTime > maxWait) {
        throw new Error(`Connection pool timeout: No available connections for ${rpcUrl}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
  }
  
  /**
   * Create abort signal for request timeout
   */
  private createTimeoutSignal(): AbortSignal {
    const controller = new AbortController();
    
    setTimeout(() => {
      controller.abort();
    }, this.config.socketTimeout);
    
    return controller.signal;
  }
  
  /**
   * Track active request
   */
  private trackRequest(rpcUrl: string, requestId: string): void {
    if (!this.activeRequests.has(rpcUrl)) {
      this.activeRequests.set(rpcUrl, new Set());
    }
    
    this.activeRequests.get(rpcUrl)!.add(requestId);
  }
  
  /**
   * Untrack completed request
   */
  private untrackRequest(rpcUrl: string, requestId: string): void {
    const requests = this.activeRequests.get(rpcUrl);
    if (requests) {
      requests.delete(requestId);
      
      if (requests.size === 0) {
        this.activeRequests.delete(rpcUrl);
      }
    }
  }
  
  /**
   * Get or create stats for RPC URL
   */
  private getOrCreateStats(rpcUrl: string): ConnectionStats {
    if (!this.connectionStats.has(rpcUrl)) {
      this.connectionStats.set(rpcUrl, {
        activeConnections: 0,
        idleConnections: 0,
        totalRequests: 0,
        avgResponseTime: 0,
        lastUsed: 0,
        errors: 0
      });
    }
    
    return this.connectionStats.get(rpcUrl)!;
  }
  
  /**
   * Update average response time
   */
  private updateResponseTime(stats: ConnectionStats, responseTime: number): void {
    if (stats.avgResponseTime === 0) {
      stats.avgResponseTime = responseTime;
    } else {
      // Exponential moving average
      const alpha = 0.2;
      stats.avgResponseTime = alpha * responseTime + (1 - alpha) * stats.avgResponseTime;
    }
  }
  
  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Get connection pool statistics
   */
  getPoolStats(): Map<string, ConnectionStats> {
    return new Map(this.connectionStats);
  }
  
  /**
   * Get active connections for specific RPC
   */
  getActiveConnections(rpcUrl: string): number {
    const stats = this.connectionStats.get(rpcUrl);
    return stats ? stats.activeConnections : 0;
  }
  
  /**
   * Clean up idle connections
   */
  cleanupIdleConnections(): void {
    const now = Date.now();
    
    for (const [rpcUrl, stats] of this.connectionStats.entries()) {
      // Remove stats for connections not used recently
      if (stats.activeConnections === 0 && 
          stats.lastUsed > 0 && 
          now - stats.lastUsed > this.config.keepAliveTimeout) {
        
        this.connectionStats.delete(rpcUrl);
        this.activeRequests.delete(rpcUrl);
      }
    }
  }
  
  /**
   * Force close all connections for an RPC
   */
  closeConnections(rpcUrl: string): void {
    this.connectionStats.delete(rpcUrl);
    this.activeRequests.delete(rpcUrl);
  }
  
  /**
   * Adjust pool size based on load
   */
  adjustPoolSize(rpcUrl: string, targetLoad: number): void {
    const stats = this.connectionStats.get(rpcUrl);
    if (!stats) return;
    
    // Calculate optimal pool size based on load
    const currentUtilization = stats.activeConnections / this.config.maxSockets;
    
    if (currentUtilization > 0.8 && targetLoad > stats.totalRequests) {
      // Increase pool size if heavily utilized and expecting more load
      this.config.maxSockets = Math.min(this.config.maxSockets + 2, 20);
    } else if (currentUtilization < 0.2 && this.config.maxSockets > this.DEFAULT_MAX_SOCKETS) {
      // Decrease pool size if underutilized
      this.config.maxSockets = Math.max(this.config.maxSockets - 1, this.DEFAULT_MAX_SOCKETS);
    }
  }
  
  /**
   * Get health status of connection pool
   */
  getHealthStatus(): {
    healthy: boolean;
    totalActive: number;
    totalIdle: number;
    errorRate: number;
    avgResponseTime: number;
  } {
    let totalActive = 0;
    let totalIdle = 0;
    let totalErrors = 0;
    let totalRequests = 0;
    let totalResponseTime = 0;
    let rpcCount = 0;
    
    for (const stats of this.connectionStats.values()) {
      totalActive += stats.activeConnections;
      totalIdle += stats.idleConnections;
      totalErrors += stats.errors;
      totalRequests += stats.totalRequests;
      
      if (stats.avgResponseTime > 0) {
        totalResponseTime += stats.avgResponseTime;
        rpcCount++;
      }
    }
    
    const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;
    const avgResponseTime = rpcCount > 0 ? totalResponseTime / rpcCount : 0;
    
    return {
      healthy: errorRate < 0.1 && avgResponseTime < 5000,
      totalActive,
      totalIdle,
      errorRate,
      avgResponseTime
    };
  }
}