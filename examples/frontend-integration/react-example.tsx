/**
 * React Integration Example for OpenAuth
 * 
 * This example shows how to integrate OpenAuth with a React application
 * using custom hooks and context for state management.
 */

import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { AuthClient, User } from '../../../src/client-sdk';

// Configuration
const AUTH_CONFIG = {
  authServerUrl: 'https://your-worker.workers.dev', // Replace with your OpenAuth server URL
  clientId: 'your-client-id', // Replace with your client ID
  redirectUri: typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : '',
  scope: 'openid profile email'
};

// Auth Context
interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: () => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
  client: AuthClient;
}

const AuthContext = createContext<AuthContextType | null>(null);

// Auth Provider Component
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const client = new AuthClient(AUTH_CONFIG);

  useEffect(() => {
    initializeAuth();
  }, []);

  const initializeAuth = async () => {
    try {
      // Check if we're in a callback flow
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('code')) {
        setIsLoading(true);
        
        const success = await client.handleCallback();
        if (success) {
          const userData = client.getStoredUser();
          setUser(userData);
        }
        
        // Clean up URL
        window.history.replaceState({}, document.title, window.location.pathname);
      } else if (client.isAuthenticated()) {
        // Load user if authenticated
        const userData = await client.getCurrentUser();
        setUser(userData);
      }
    } catch (error) {
      console.error('Auth initialization error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const login = () => {
    client.login();
  };

  const logout = () => {
    client.logout();
    setUser(null);
  };

  const refreshUser = async () => {
    if (client.isAuthenticated()) {
      const userData = await client.getCurrentUser();
      setUser(userData);
    }
  };

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated: client.isAuthenticated(),
    login,
    logout,
    refreshUser,
    client
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

// Custom Hook
export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Login Component
export function LoginButton() {
  const { login, isLoading } = useAuth();

  return (
    <button 
      onClick={login} 
      disabled={isLoading}
      className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded disabled:opacity-50"
    >
      {isLoading ? 'Loading...' : 'Login with OpenAuth'}
    </button>
  );
}

// User Profile Component
export function UserProfile() {
  const { user, logout, refreshUser, isAuthenticated } = useAuth();

  if (!isAuthenticated || !user) {
    return null;
  }

  return (
    <div className="bg-white shadow rounded-lg p-6">
      <div className="flex items-center space-x-4">
        {user.avatar_url && (
          <img 
            src={user.avatar_url} 
            alt="User Avatar"
            className="w-16 h-16 rounded-full"
          />
        )}
        <div>
          <h2 className="text-xl font-semibold">
            {user.first_name && user.last_name 
              ? `${user.first_name} ${user.last_name}`
              : user.email
            }
          </h2>
          <p className="text-gray-600">{user.email}</p>
          <p className="text-sm text-gray-500">Role: {user.role || 'customer'}</p>
        </div>
      </div>
      
      <div className="mt-4 flex space-x-2">
        <button 
          onClick={refreshUser}
          className="bg-green-600 hover:bg-green-700 text-white font-bold py-1 px-3 rounded text-sm"
        >
          Refresh
        </button>
        <button 
          onClick={logout}
          className="bg-red-600 hover:bg-red-700 text-white font-bold py-1 px-3 rounded text-sm"
        >
          Logout
        </button>
      </div>
    </div>
  );
}

// Protected Route Component
interface ProtectedRouteProps {
  children: ReactNode;
  requiredRole?: string;
  fallback?: ReactNode;
}

export function ProtectedRoute({ children, requiredRole, fallback }: ProtectedRouteProps) {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return fallback || (
      <div className="text-center py-8">
        <h2 className="text-2xl font-bold mb-4">Authentication Required</h2>
        <p className="text-gray-600 mb-4">Please login to access this page.</p>
        <LoginButton />
      </div>
    );
  }

  if (requiredRole && user?.role !== requiredRole) {
    return fallback || (
      <div className="text-center py-8">
        <h2 className="text-2xl font-bold mb-4">Access Denied</h2>
        <p className="text-gray-600 mb-4">You don't have the required permissions.</p>
      </div>
    );
  }

  return <>{children}</>;
}

// API Testing Component
export function ApiTester() {
  const { client } = useAuth();
  const [response, setResponse] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const testApi = async (endpoint: string) => {
    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const res = await client.authenticatedFetch(`${AUTH_CONFIG.authServerUrl}${endpoint}`);
      const data = await res.json();
      setResponse({ endpoint, status: res.status, data });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white shadow rounded-lg p-6">
      <h3 className="text-lg font-semibold mb-4">API Testing</h3>
      
      <div className="space-x-2 mb-4">
        <button 
          onClick={() => testApi('/api/protected')}
          disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-1 px-3 rounded text-sm disabled:opacity-50"
        >
          Test Protected API
        </button>
        <button 
          onClick={() => testApi('/api/admin')}
          disabled={loading}
          className="bg-purple-600 hover:bg-purple-700 text-white font-bold py-1 px-3 rounded text-sm disabled:opacity-50"
        >
          Test Admin API
        </button>
      </div>

      {loading && (
        <div className="text-blue-600">Testing API...</div>
      )}

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          Error: {error}
        </div>
      )}

      {response && (
        <div className="bg-gray-100 p-4 rounded">
          <h4 className="font-semibold mb-2">Response from {response.endpoint}:</h4>
          <pre className="text-sm overflow-auto">
            {JSON.stringify(response, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// Main App Component Example
export function App() {
  return (
    <AuthProvider>
      <div className="min-h-screen bg-gray-100">
        <nav className="bg-white shadow">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between h-16">
              <div className="flex items-center">
                <h1 className="text-xl font-semibold">OpenAuth Demo</h1>
              </div>
              <div className="flex items-center">
                <AuthNav />
              </div>
            </div>
          </div>
        </nav>

        <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            <AuthContent />
          </div>
        </main>
      </div>
    </AuthProvider>
  );
}

// Navigation Component
function AuthNav() {
  const { isAuthenticated, user } = useAuth();

  if (!isAuthenticated) {
    return <LoginButton />;
  }

  return (
    <div className="flex items-center space-x-4">
      <span className="text-gray-700">
        Welcome, {user?.first_name || user?.email}!
      </span>
      <UserProfile />
    </div>
  );
}

// Main Content Component
function AuthContent() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return (
      <div className="text-center">
        <h2 className="text-3xl font-bold text-gray-900 mb-4">
          Welcome to OpenAuth Demo
        </h2>
        <p className="text-gray-600 mb-8">
          This is a demonstration of OpenAuth integration with React.
        </p>
        <LoginButton />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Dashboard</h2>
        <UserProfile />
      </div>
      
      <ProtectedRoute requiredRole="admin">
        <div>
          <h3 className="text-xl font-semibold mb-4">Admin Section</h3>
          <div className="bg-yellow-100 border border-yellow-400 text-yellow-700 px-4 py-3 rounded">
            This content is only visible to admin users.
          </div>
        </div>
      </ProtectedRoute>

      <ApiTester />
    </div>
  );
}

// Example usage in different pages
export function HomePage() {
  return (
    <div>
      <h1>Home Page</h1>
      <p>This page is accessible to everyone.</p>
      <LoginButton />
    </div>
  );
}

export function DashboardPage() {
  return (
    <ProtectedRoute>
      <div>
        <h1>Dashboard</h1>
        <p>This page requires authentication.</p>
        <UserProfile />
      </div>
    </ProtectedRoute>
  );
}

export function AdminPage() {
  return (
    <ProtectedRoute requiredRole="admin">
      <div>
        <h1>Admin Panel</h1>
        <p>This page requires admin role.</p>
        <UserProfile />
      </div>
    </ProtectedRoute>
  );
}

export default App;
