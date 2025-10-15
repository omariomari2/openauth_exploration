/**
 * Example Cloudflare Worker with OpenAuth Integration
 * 
 * This example shows how to protect API routes using the OpenAuth middleware
 * and demonstrates role-based access control.
 */

import {
  requireAuth,
  requireRole,
  optionalAuth,
  createProtectedHandler,
  createRoleProtectedHandler,
  createOptionalAuthHandler,
  handleCors,
  addCorsHeaders,
  applyRateLimit,
  RateLimiter
} from '../../src/middleware/auth';

// Environment interface
interface Env {
  AUTH_SERVER_URL: string;
  // Add other environment variables as needed
}

// Rate limiter instance
const rateLimiter = new RateLimiter(100, 60000); // 100 requests per minute

// Main worker handler
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    const corsResponse = handleCors(request);
    if (corsResponse) return corsResponse;

    // Apply rate limiting
    const rateLimitResponse = applyRateLimit(request, rateLimiter);
    if (rateLimitResponse) return rateLimitResponse;

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Public endpoints (no authentication required)
      if (path.startsWith('/api/public/')) {
        return handlePublicRequest(request, env);
      }

      // Protected endpoints (authentication required)
      if (path.startsWith('/api/protected/')) {
        return handleProtectedRequest(request, env);
      }

      // Admin endpoints (admin role required)
      if (path.startsWith('/api/admin/')) {
        return handleAdminRequest(request, env);
      }

      // Optional auth endpoints (attach user if authenticated)
      if (path.startsWith('/api/optional/')) {
        return handleOptionalAuthRequest(request, env);
      }

      // Health check endpoint
      if (path === '/health') {
        return new Response(JSON.stringify({ 
          status: 'healthy', 
          timestamp: new Date().toISOString() 
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ 
        error: 'Internal Server Error' 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
} satisfies ExportedHandler<Env>;

// Public endpoints handler
async function handlePublicRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  switch (path) {
    case '/api/public/products':
      return handleGetProducts(request, env);
    
    case '/api/public/categories':
      return handleGetCategories(request, env);
    
    default:
      return new Response('Not Found', { status: 404 });
  }
}

// Protected endpoints handler
async function handleProtectedRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Create protected handlers
  const handlers = {
    '/api/protected/profile': createProtectedHandler(handleGetProfile, env.AUTH_SERVER_URL),
    '/api/protected/orders': createProtectedHandler(handleGetOrders, env.AUTH_SERVER_URL),
    '/api/protected/cart': createProtectedHandler(handleCartOperations, env.AUTH_SERVER_URL),
  };

  const handler = handlers[path as keyof typeof handlers];
  if (handler) {
    return handler(request, env);
  }

  return new Response('Not Found', { status: 404 });
}

// Admin endpoints handler
async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Create admin-protected handlers
  const handlers = {
    '/api/admin/users': createRoleProtectedHandler(handleAdminUsers, env.AUTH_SERVER_URL, 'admin'),
    '/api/admin/orders': createRoleProtectedHandler(handleAdminOrders, env.AUTH_SERVER_URL, 'admin'),
    '/api/admin/analytics': createRoleProtectedHandler(handleAdminAnalytics, env.AUTH_SERVER_URL, 'admin'),
  };

  const handler = handlers[path as keyof typeof handlers];
  if (handler) {
    return handler(request, env);
  }

  return new Response('Not Found', { status: 404 });
}

// Optional auth endpoints handler
async function handleOptionalAuthRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Create optional auth handlers
  const handlers = {
    '/api/optional/recommendations': createOptionalAuthHandler(handleRecommendations, env.AUTH_SERVER_URL),
    '/api/optional/wishlist': createOptionalAuthHandler(handleWishlist, env.AUTH_SERVER_URL),
  };

  const handler = handlers[path as keyof typeof handlers];
  if (handler) {
    return handler(request, env);
  }

  return new Response('Not Found', { status: 404 });
}

// Handler implementations

// Public endpoints
async function handleGetProducts(request: Request, env: Env): Promise<Response> {
  const products = [
    { id: 1, name: 'Product 1', price: 29.99, category: 'electronics' },
    { id: 2, name: 'Product 2', price: 19.99, category: 'clothing' },
    { id: 3, name: 'Product 3', price: 39.99, category: 'home' }
  ];

  return addCorsHeaders(new Response(JSON.stringify({ products }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function handleGetCategories(request: Request, env: Env): Promise<Response> {
  const categories = [
    { id: 1, name: 'Electronics', slug: 'electronics' },
    { id: 2, name: 'Clothing', slug: 'clothing' },
    { id: 3, name: 'Home & Garden', slug: 'home' }
  ];

  return addCorsHeaders(new Response(JSON.stringify({ categories }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

// Protected endpoints
async function handleGetProfile(request: Request, user: any, env: Env): Promise<Response> {
  // In a real app, you might fetch additional profile data from your database
  const profile = {
    ...user,
    preferences: {
      newsletter: true,
      notifications: true,
      theme: 'light'
    },
    addresses: [
      {
        id: 1,
        type: 'billing',
        street: '123 Main St',
        city: 'Anytown',
        state: 'CA',
        zipCode: '12345',
        country: 'US'
      }
    ]
  };

  return addCorsHeaders(new Response(JSON.stringify({ profile }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function handleGetOrders(request: Request, user: any, env: Env): Promise<Response> {
  // Mock orders data
  const orders = [
    {
      id: 'order-1',
      userId: user.id,
      status: 'completed',
      total: 99.98,
      items: [
        { productId: 1, quantity: 2, price: 29.99 },
        { productId: 2, quantity: 1, price: 39.99 }
      ],
      createdAt: '2024-01-15T10:30:00Z'
    },
    {
      id: 'order-2',
      userId: user.id,
      status: 'pending',
      total: 49.99,
      items: [
        { productId: 3, quantity: 1, price: 49.99 }
      ],
      createdAt: '2024-01-20T14:15:00Z'
    }
  ];

  return addCorsHeaders(new Response(JSON.stringify({ orders }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function handleCartOperations(request: Request, user: any, env: Env): Promise<Response> {
  const method = request.method;
  
  if (method === 'GET') {
    // Get cart items
    const cart = [
      { productId: 1, quantity: 2, price: 29.99 },
      { productId: 3, quantity: 1, price: 39.99 }
    ];
    
    return addCorsHeaders(new Response(JSON.stringify({ cart }), {
      headers: { 'Content-Type': 'application/json' }
    }));
  }
  
  if (method === 'POST') {
    // Add item to cart
    const body = await request.json();
    // In a real app, you'd save this to a database
    const cartItem = {
      userId: user.id,
      productId: body.productId,
      quantity: body.quantity,
      addedAt: new Date().toISOString()
    };
    
    return addCorsHeaders(new Response(JSON.stringify({ 
      message: 'Item added to cart',
      item: cartItem 
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    }));
  }
  
  return new Response('Method not allowed', { status: 405 });
}

// Admin endpoints
async function handleAdminUsers(request: Request, user: any, env: Env): Promise<Response> {
  // Mock admin user management
  const users = [
    { id: 'user-1', email: 'user1@example.com', role: 'customer', createdAt: '2024-01-01' },
    { id: 'user-2', email: 'user2@example.com', role: 'vendor', createdAt: '2024-01-02' },
    { id: 'user-3', email: 'admin@example.com', role: 'admin', createdAt: '2024-01-03' }
  ];

  return addCorsHeaders(new Response(JSON.stringify({ 
    users,
    admin: user.email 
  }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function handleAdminOrders(request: Request, user: any, env: Env): Promise<Response> {
  // Mock admin order management
  const orders = [
    { id: 'order-1', userId: 'user-1', status: 'completed', total: 99.98 },
    { id: 'order-2', userId: 'user-2', status: 'pending', total: 49.99 },
    { id: 'order-3', userId: 'user-1', status: 'shipped', total: 79.97 }
  ];

  return addCorsHeaders(new Response(JSON.stringify({ 
    orders,
    totalOrders: orders.length,
    totalRevenue: orders.reduce((sum, order) => sum + order.total, 0)
  }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function handleAdminAnalytics(request: Request, user: any, env: Env): Promise<Response> {
  // Mock admin analytics
  const analytics = {
    totalUsers: 1250,
    totalOrders: 3456,
    totalRevenue: 98765.43,
    topProducts: [
      { id: 1, name: 'Product 1', sales: 150 },
      { id: 2, name: 'Product 2', sales: 120 },
      { id: 3, name: 'Product 3', sales: 95 }
    ],
    dailyStats: {
      today: { orders: 25, revenue: 1250.00 },
      yesterday: { orders: 32, revenue: 1580.50 }
    }
  };

  return addCorsHeaders(new Response(JSON.stringify({ analytics }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

// Optional auth endpoints
async function handleRecommendations(request: Request, user: any, env: Env): Promise<Response> {
  // Personalized recommendations if user is authenticated
  let recommendations;
  
  if (user) {
    recommendations = [
      { id: 4, name: 'Personalized Product 1', reason: 'Based on your purchase history' },
      { id: 5, name: 'Personalized Product 2', reason: 'Similar customers also bought' }
    ];
  } else {
    recommendations = [
      { id: 1, name: 'Popular Product 1', reason: 'Trending now' },
      { id: 2, name: 'Popular Product 2', reason: 'Best seller' }
    ];
  }

  return addCorsHeaders(new Response(JSON.stringify({ 
    recommendations,
    personalized: !!user 
  }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function handleWishlist(request: Request, user: any, env: Env): Promise<Response> {
  if (!user) {
    return addCorsHeaders(new Response(JSON.stringify({ 
      message: 'Please login to manage your wishlist' 
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  // Mock wishlist data
  const wishlist = [
    { id: 6, name: 'Wishlist Item 1', price: 89.99, addedAt: '2024-01-15' },
    { id: 7, name: 'Wishlist Item 2', price: 129.99, addedAt: '2024-01-18' }
  ];

  return addCorsHeaders(new Response(JSON.stringify({ wishlist }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}
