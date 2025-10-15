/**
 * Token Validation Utilities
 * Helper functions for JWT token validation and user data extraction
 */

export interface TokenPayload {
  sub: string; // Subject (user ID)
  email?: string;
  name?: string;
  picture?: string;
  role?: string;
  iat: number; // Issued at
  exp: number; // Expires at
  iss: string; // Issuer
  aud: string; // Audience
}

export interface ValidationResult {
  valid: boolean;
  payload?: TokenPayload;
  error?: string;
}

/**
 * Parse JWT token without verification (for client-side use)
 * Note: This doesn't verify the signature - use server-side validation for security
 */
export function parseJWT(token: string): TokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const payload = JSON.parse(atob(parts[1]));
    return payload;
  } catch (error) {
    console.error('JWT parsing failed:', error);
    return null;
  }
}

/**
 * Check if token is expired
 */
export function isTokenExpired(token: string): boolean {
  const payload = parseJWT(token);
  if (!payload) return true;

  const now = Math.floor(Date.now() / 1000);
  return payload.exp < now;
}

/**
 * Get token expiration time in milliseconds
 */
export function getTokenExpiration(token: string): number | null {
  const payload = parseJWT(token);
  if (!payload) return null;

  return payload.exp * 1000;
}

/**
 * Get time until token expires in milliseconds
 */
export function getTimeUntilExpiration(token: string): number | null {
  const expiration = getTokenExpiration(token);
  if (!expiration) return null;

  const now = Date.now();
  return Math.max(0, expiration - now);
}

/**
 * Extract user data from token payload
 */
export function extractUserFromToken(token: string): any | null {
  const payload = parseJWT(token);
  if (!payload) return null;

  return {
    id: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    role: payload.role
  };
}

/**
 * Validate token format and basic structure
 */
export function validateTokenFormat(token: string): ValidationResult {
  if (!token || typeof token !== 'string') {
    return {
      valid: false,
      error: 'Token is required and must be a string'
    };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return {
      valid: false,
      error: 'Invalid token format'
    };
  }

  try {
    const header = JSON.parse(atob(parts[0]));
    const payload = JSON.parse(atob(parts[1]));

    if (!header.alg || !header.typ) {
      return {
        valid: false,
        error: 'Invalid token header'
      };
    }

    if (!payload.sub || !payload.exp || !payload.iat) {
      return {
        valid: false,
        error: 'Invalid token payload'
      };
    }

    return {
      valid: true,
      payload
    };
  } catch (error) {
    return {
      valid: false,
      error: 'Token parsing failed'
    };
  }
}

/**
 * Create error response for authentication failures
 */
export function createAuthErrorResponse(
  message: string,
  status: number = 401,
  code?: string
): Response {
  return new Response(JSON.stringify({
    error: message,
    code: code || 'AUTH_ERROR',
    timestamp: new Date().toISOString()
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer'
    }
  });
}

/**
 * Create success response with user data
 */
export function createAuthSuccessResponse(
  user: any,
  additionalData?: any
): Response {
  return new Response(JSON.stringify({
    success: true,
    user,
    ...additionalData
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

/**
 * Generate secure random string for state parameter
 */
export function generateSecureState(length: number = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return result;
}

/**
 * Generate secure random string for PKCE code verifier
 */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode.apply(null, Array.from(array)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Generate PKCE code challenge from verifier
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(digest))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Sanitize user data for public consumption
 */
export function sanitizeUserData(user: any): any {
  const sanitized = {
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    avatar_url: user.avatar_url,
    role: user.role
  };

  // Remove undefined values
  return Object.fromEntries(
    Object.entries(sanitized).filter(([_, value]) => value !== undefined)
  );
}

/**
 * Check if user has required permission
 */
export function hasPermission(userRole: string, requiredRole: string): boolean {
  const roleHierarchy = {
    'admin': 3,
    'vendor': 2,
    'customer': 1
  };

  const userLevel = roleHierarchy[userRole as keyof typeof roleHierarchy] || 0;
  const requiredLevel = roleHierarchy[requiredRole as keyof typeof roleHierarchy] || 0;

  return userLevel >= requiredLevel;
}

/**
 * Extract client IP from request
 */
export function getClientIP(request: Request): string {
  // Cloudflare Workers specific headers
  return request.headers.get('CF-Connecting-IP') || 
         request.headers.get('X-Forwarded-For') || 
         request.headers.get('X-Real-IP') || 
         'unknown';
}

/**
 * Create rate limit key based on request
 */
export function createRateLimitKey(request: Request, identifier?: string): string {
  const ip = getClientIP(request);
  const userAgent = request.headers.get('User-Agent') || '';
  
  if (identifier) {
    return `auth:${identifier}`;
  }
  
  return `auth:${ip}:${userAgent.slice(0, 50)}`;
}
