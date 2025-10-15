/**
 * Authentication Middleware for Cloudflare Workers
 * Provides route protection and user authentication utilities
 */

export interface User {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  avatar_url?: string;
  role?: string;
}

export interface AuthConfig {
  authServerUrl: string;
}

export interface AuthResult {
  user: User | null;
  error?: string;
  status: number;
}

/**
 * Extract access token from request headers
 */
export function extractToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;
  
  const token = authHeader.replace('Bearer ', '');
  return token || null;
}

/**
 * Validate access token with OpenAuth server
 */
export async function validateToken(token: string, authServerUrl: string): Promise<User | null> {
  try {
    const response = await fetch(`${authServerUrl}/userinfo`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Token validation failed:', error);
    return null;
  }
}

/**
 * Require authentication for a route
 * Returns user if authenticated, null if not
 */
export async function requireAuth(
  request: Request, 
  authServerUrl: string
): Promise<AuthResult> {
  const token = extractToken(request);
  
  if (!token) {
    return {
      user: null,
      error: 'No authorization token provided',
      status: 401
    };
  }

  const user = await validateToken(token, authServerUrl);
  
  if (!user) {
    return {
      user: null,
      error: 'Invalid or expired token',
      status: 401
    };
  }

  return {
    user,
    status: 200
  };
}

/**
 * Require specific role for a route
 * Returns user if authenticated and has required role, null if not
 */
export async function requireRole(
  request: Request,
  authServerUrl: string,
  requiredRole: string
): Promise<AuthResult> {
  const authResult = await requireAuth(request, authServerUrl);
  
  if (!authResult.user) {
    return authResult;
  }

  if (authResult.user.role !== requiredRole) {
    return {
      user: null,
      error: `Required role: ${requiredRole}`,
      status: 403
    };
  }

  return authResult;
}

/**
 * Optional authentication - attach user if authenticated
 * Always returns success, but user may be null
 */
export async function optionalAuth(
  request: Request,
  authServerUrl: string
): Promise<AuthResult> {
  const token = extractToken(request);
  
  if (!token) {
    return {
      user: null,
      status: 200
    };
  }

  const user = await validateToken(token, authServerUrl);
  
  return {
    user,
    status: 200
  };
}

/**
 * Create a protected route handler
 */
export function createProtectedHandler(
  handler: (request: Request, user: User, env: any) => Promise<Response>,
  authServerUrl: string
) {
  return async (request: Request, env: any): Promise<Response> => {
    const authResult = await requireAuth(request, authServerUrl);
    
    if (!authResult.user) {
      return new Response(JSON.stringify({ error: authResult.error }), {
        status: authResult.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return handler(request, authResult.user, env);
  };
}

/**
 * Create a role-based protected route handler
 */
export function createRoleProtectedHandler(
  handler: (request: Request, user: User, env: any) => Promise<Response>,
  authServerUrl: string,
  requiredRole: string
) {
  return async (request: Request, env: any): Promise<Response> => {
    const authResult = await requireRole(request, authServerUrl, requiredRole);
    
    if (!authResult.user) {
      return new Response(JSON.stringify({ error: authResult.error }), {
        status: authResult.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return handler(request, authResult.user, env);
  };
}

/**
 * Create an optional auth handler
 */
export function createOptionalAuthHandler(
  handler: (request: Request, user: User | null, env: any) => Promise<Response>,
  authServerUrl: string
) {
  return async (request: Request, env: any): Promise<Response> => {
    const authResult = await optionalAuth(request, authServerUrl);
    return handler(request, authResult.user, env);
  };
}

/**
 * CORS headers for API responses
 */
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * Handle CORS preflight requests
 */
export function handleCors(request: Request): Response | null {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: corsHeaders
    });
  }
  return null;
}

/**
 * Add CORS headers to response
 */
export function addCorsHeaders(response: Response): Response {
  const newResponse = new Response(response.body, response);
  
  Object.entries(corsHeaders).forEach(([key, value]) => {
    newResponse.headers.set(key, value);
  });
  
  return newResponse;
}

/**
 * Rate limiting utility
 */
export class RateLimiter {
  private requests = new Map<string, { count: number; resetTime: number }>();
  private limit: number;
  private windowMs: number;

  constructor(limit: number = 100, windowMs: number = 60000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  check(identifier: string): boolean {
    const now = Date.now();
    const key = identifier;
    const record = this.requests.get(key);

    if (!record || now > record.resetTime) {
      this.requests.set(key, { count: 1, resetTime: now + this.windowMs });
      return true;
    }

    if (record.count >= this.limit) {
      return false;
    }

    record.count++;
    return true;
  }

  getRemainingTime(identifier: string): number {
    const record = this.requests.get(identifier);
    if (!record) return 0;
    return Math.max(0, record.resetTime - Date.now());
  }
}

/**
 * Apply rate limiting to a request
 */
export function applyRateLimit(
  request: Request,
  rateLimiter: RateLimiter,
  identifier?: string
): Response | null {
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = identifier || clientIP;
  
  if (!rateLimiter.check(key)) {
    const remainingTime = rateLimiter.getRemainingTime(key);
    return new Response(JSON.stringify({
      error: 'Rate limit exceeded',
      retryAfter: Math.ceil(remainingTime / 1000)
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': Math.ceil(remainingTime / 1000).toString(),
        ...corsHeaders
      }
    });
  }
  
  return null;
}
