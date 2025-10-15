/**
 * OpenAuth Client SDK
 * Easy integration for frontend applications
 */

// Browser environment detection
declare const window: any;
declare const localStorage: any;
declare const document: any;

export interface User {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  avatar_url?: string;
  role?: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface AuthConfig {
  authServerUrl: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
}

export class AuthClient {
  private config: AuthConfig;
  private tokenStorageKey = 'openauth_tokens';
  private userStorageKey = 'openauth_user';

  constructor(config: AuthConfig) {
    this.config = config;
  }

  /**
   * Initiate OAuth login flow
   */
  login(): void {
    if (typeof window === 'undefined') {
      throw new Error('login() can only be called in browser environment');
    }

    const authUrl = `${this.config.authServerUrl}/authorize?` + 
      new URLSearchParams({
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri,
        response_type: 'code',
        scope: this.config.scope || 'openid profile email',
        state: this.generateState()
      });

    window.location.href = authUrl;
  }

  /**
   * Handle OAuth callback and exchange code for tokens
   */
  async handleCallback(): Promise<boolean> {
    if (typeof window === 'undefined') {
      throw new Error('handleCallback() can only be called in browser environment');
    }

    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');
    const error = urlParams.get('error');

    if (error) {
      console.error('OAuth error:', error);
      return false;
    }

    if (!code || !this.validateState(state)) {
      console.error('Invalid callback parameters');
      return false;
    }

    try {
      const tokens = await this.exchangeCodeForTokens(code);
      await this.storeTokens(tokens);
      
      // Fetch user profile
      const user = await this.getCurrentUser();
      if (user) {
        this.storeUser(user);
      }
      
      return true;
    } catch (error) {
      console.error('Token exchange failed:', error);
      return false;
    }
  }

  /**
   * Get current authenticated user
   */
  async getCurrentUser(): Promise<User | null> {
    const tokens = this.getStoredTokens();
    if (!tokens) {
      return null;
    }

    try {
      const response = await fetch(`${this.config.authServerUrl}/userinfo`, {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        // Try to refresh token if expired
        const refreshed = await this.refreshToken();
        if (refreshed) {
          return this.getCurrentUser(); // Retry with new token
        }
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('Failed to get user info:', error);
      return null;
    }
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    const tokens = this.getStoredTokens();
    if (!tokens) return false;

    // Check if token is expired
    if (typeof localStorage !== 'undefined') {
      const expiresAt = localStorage.getItem('openauth_token_expires');
      if (expiresAt && Date.now() > parseInt(expiresAt)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Logout user and clear stored data
   */
  logout(): void {
    if (typeof localStorage === 'undefined') return;
    
    localStorage.removeItem(this.tokenStorageKey);
    localStorage.removeItem(this.userStorageKey);
    localStorage.removeItem('openauth_token_expires');
    localStorage.removeItem('openauth_state');
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(): Promise<boolean> {
    const tokens = this.getStoredTokens();
    if (!tokens?.refresh_token) {
      return false;
    }

    try {
      const response = await fetch(`${this.config.authServerUrl}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: this.config.clientId
        })
      });

      if (!response.ok) {
        return false;
      }

      const newTokens: AuthTokens = await response.json();
      await this.storeTokens(newTokens);
      return true;
    } catch (error) {
      console.error('Token refresh failed:', error);
      return false;
    }
  }

  /**
   * Get stored tokens from localStorage
   */
  private getStoredTokens(): AuthTokens | null {
    if (typeof localStorage === 'undefined') return null;
    const stored = localStorage.getItem(this.tokenStorageKey);
    return stored ? JSON.parse(stored) : null;
  }

  /**
   * Store tokens in localStorage
   */
  private async storeTokens(tokens: AuthTokens): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    
    localStorage.setItem(this.tokenStorageKey, JSON.stringify(tokens));
    
    // Store expiration time
    const expiresAt = Date.now() + (tokens.expires_in * 1000);
    localStorage.setItem('openauth_token_expires', expiresAt.toString());
  }

  /**
   * Store user data in localStorage
   */
  private storeUser(user: User): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(this.userStorageKey, JSON.stringify(user));
  }

  /**
   * Get stored user data from localStorage
   */
  getStoredUser(): User | null {
    if (typeof localStorage === 'undefined') return null;
    const stored = localStorage.getItem(this.userStorageKey);
    return stored ? JSON.parse(stored) : null;
  }

  /**
   * Exchange authorization code for tokens
   */
  private async exchangeCodeForTokens(code: string): Promise<AuthTokens> {
    const response = await fetch(`${this.config.authServerUrl}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri
      })
    });

    if (!response.ok) {
      throw new Error('Token exchange failed');
    }

    return await response.json();
  }

  /**
   * Generate random state for CSRF protection
   */
  private generateState(): string {
    const state = Math.random().toString(36).substring(2, 15) + 
                  Math.random().toString(36).substring(2, 15);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('openauth_state', state);
    }
    return state;
  }

  /**
   * Validate state parameter for CSRF protection
   */
  private validateState(state: string | null): boolean {
    if (typeof localStorage === 'undefined') return false;
    const storedState = localStorage.getItem('openauth_state');
    localStorage.removeItem('openauth_state');
    return state === storedState;
  }

  /**
   * Make authenticated API request
   */
  async authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const tokens = this.getStoredTokens();
    if (!tokens) {
      throw new Error('Not authenticated');
    }

    // Add authorization header
    const headers = {
      ...options.headers,
      'Authorization': `Bearer ${tokens.access_token}`
    };

    const response = await fetch(url, {
      ...options,
      headers
    });

    // If unauthorized, try to refresh token
    if (response.status === 401) {
      const refreshed = await this.refreshToken();
      if (refreshed) {
        // Retry request with new token
        const newTokens = this.getStoredTokens();
        const newHeaders = {
          ...options.headers,
          'Authorization': `Bearer ${newTokens!.access_token}`
        };
        return fetch(url, {
          ...options,
          headers: newHeaders
        });
      }
    }

    return response;
  }
}

/**
 * React Hook for authentication
 */
export function useAuth(config: AuthConfig) {
  const client = new AuthClient(config);
  
  const [user, setUser] = useState(client.getStoredUser());
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Check if we're in a callback flow
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('code')) {
      setIsLoading(true);
      client.handleCallback().then(success => {
        if (success) {
          setUser(client.getStoredUser());
        }
        setIsLoading(false);
        // Clean up URL
        window.history.replaceState({}, document.title, window.location.pathname);
      });
    } else if (client.isAuthenticated() && !user) {
      // Load user if authenticated but not in state
      client.getCurrentUser().then(userData => {
        setUser(userData);
      });
    }
  }, []);

  const login = () => {
    client.login();
  };

  const logout = () => {
    client.logout();
    setUser(null);
  };

  return {
    user,
    isLoading,
    isAuthenticated: client.isAuthenticated(),
    login,
    logout,
    client
  };
}

// React import for the hook (would be in actual React app)
declare const useState: any;
declare const useEffect: any;
