# Frontend Integration Examples

This directory contains examples of how to integrate the OpenAuth server with various frontend frameworks.

## Files

- `vanilla-js.html` - Complete OAuth flow example using vanilla JavaScript
- `react-example.tsx` - React integration example with hooks

## Quick Start

### 1. Configure the AuthClient

```javascript
import { AuthClient } from '../../../src/client-sdk.js';

const authClient = new AuthClient({
  authServerUrl: 'https://your-worker.workers.dev',
  clientId: 'your-client-id',
  redirectUri: window.location.origin + '/auth/callback',
  scope: 'openid profile email'
});
```

### 2. Handle Authentication Flow

```javascript
// Check if user is authenticated
if (authClient.isAuthenticated()) {
  const user = authClient.getCurrentUser();
  console.log('Authenticated user:', user);
} else {
  // Redirect to login
  authClient.login();
}
```

### 3. Handle OAuth Callback

```javascript
// In your callback page
const success = await authClient.handleCallback();
if (success) {
  // Redirect to dashboard
  window.location.href = '/dashboard';
} else {
  // Show error message
  console.error('Authentication failed');
}
```

## Best Practices

### Token Management

1. **Never store sensitive tokens in localStorage for production**
2. **Use httpOnly cookies for production apps**
3. **Implement proper token refresh logic**
4. **Handle token expiration gracefully**

### Security

1. **Always validate state parameter to prevent CSRF**
2. **Use HTTPS in production**
3. **Implement proper CORS policies**
4. **Add rate limiting on client side**

### Error Handling

1. **Handle network errors gracefully**
2. **Show user-friendly error messages**
3. **Implement retry logic for failed requests**
4. **Log errors for debugging**

## Framework-Specific Examples

### React

Use the provided `useAuth` hook for state management:

```jsx
import { useAuth } from '../../../src/client-sdk.js';

function App() {
  const { user, isLoading, isAuthenticated, login, logout } = useAuth({
    authServerUrl: 'https://your-worker.workers.dev',
    clientId: 'your-client-id',
    redirectUri: window.location.origin + '/auth/callback'
  });

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      {isAuthenticated ? (
        <div>
          <p>Welcome, {user?.first_name}!</p>
          <button onClick={logout}>Logout</button>
        </div>
      ) : (
        <button onClick={login}>Login</button>
      )}
    </div>
  );
}
```

### Vue.js

```javascript
import { AuthClient } from '../../../src/client-sdk.js';

export default {
  data() {
    return {
      authClient: new AuthClient({
        authServerUrl: 'https://your-worker.workers.dev',
        clientId: 'your-client-id',
        redirectUri: window.location.origin + '/auth/callback'
      }),
      user: null,
      isLoading: false
    };
  },
  async mounted() {
    if (this.authClient.isAuthenticated()) {
      this.user = await this.authClient.getCurrentUser();
    }
  },
  methods: {
    login() {
      this.authClient.login();
    },
    async logout() {
      this.authClient.logout();
      this.user = null;
    }
  }
};
```

### Angular

```typescript
import { Injectable } from '@angular/core';
import { AuthClient } from '../../../src/client-sdk.js';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private authClient: AuthClient;

  constructor() {
    this.authClient = new AuthClient({
      authServerUrl: 'https://your-worker.workers.dev',
      clientId: 'your-client-id',
      redirectUri: window.location.origin + '/auth/callback'
    });
  }

  get isAuthenticated(): boolean {
    return this.authClient.isAuthenticated();
  }

  async getCurrentUser() {
    return await this.authClient.getCurrentUser();
  }

  login() {
    this.authClient.login();
  }

  logout() {
    this.authClient.logout();
  }
}
```

## Testing

### Unit Tests

```javascript
import { AuthClient } from '../../../src/client-sdk.js';

describe('AuthClient', () => {
  let authClient;

  beforeEach(() => {
    authClient = new AuthClient({
      authServerUrl: 'https://test.example.com',
      clientId: 'test-client',
      redirectUri: 'https://test.example.com/callback'
    });
  });

  test('should generate valid state parameter', () => {
    // Test state generation
  });

  test('should handle token exchange', async () => {
    // Mock fetch and test token exchange
  });
});
```

### Integration Tests

```javascript
// Test complete OAuth flow
test('complete OAuth flow', async () => {
  // 1. Initiate login
  // 2. Mock OAuth callback
  // 3. Verify token exchange
  // 4. Check user data
});
```

## Troubleshooting

### Common Issues

1. **CORS errors**: Ensure your auth server has proper CORS headers
2. **Invalid redirect URI**: Check that redirect URI matches exactly
3. **Token expiration**: Implement proper refresh logic
4. **State mismatch**: Ensure state parameter is properly validated

### Debug Mode

Enable debug logging:

```javascript
const authClient = new AuthClient({
  authServerUrl: 'https://your-worker.workers.dev',
  clientId: 'your-client-id',
  redirectUri: window.location.origin + '/auth/callback',
  debug: true // Enable debug logging
});
```
