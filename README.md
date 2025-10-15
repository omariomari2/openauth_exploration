# OpenAuth Server

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/openauth-template)

![OpenAuth Template Preview](https://imagedelivery.net/wSMYJvS3Xw-n339CbDyDIA/b2ff10c6-8f7c-419f-8757-e2ccf1c84500/public)

<!-- dash-content-start -->

[OpenAuth](https://openauth.js.org/) is a universal provider for managing user authentication. By deploying OpenAuth on Cloudflare Workers, you can add scalable authentication to your application. This demo showcases login, user registration, and password reset, with storage and state powered by [D1](https://developers.cloudflare.com/d1/) and [KV](https://developers.cloudflare.com/kv/). [Observability](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#enable-workers-logs) is on by default.

> [!IMPORTANT]
> When using C3 to create this project, select "no" when it asks if you want to deploy. You need to follow this project's [setup steps](https://github.com/cloudflare/templates/tree/main/openauth-template#setup-steps) before deploying.

<!-- dash-content-end -->

## Getting Started

Outside of this repo, you can start a new project with this template using [C3](https://developers.cloudflare.com/pages/get-started/c3/) (the `create-cloudflare` CLI):

```bash
npm create cloudflare@latest -- --template=cloudflare/templates/openauth-template
```

A live public deployment of this template is available at [https://openauth-template.templates.workers.dev](https://openauth-template.templates.workers.dev)

## Setup Steps

### Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up Google OAuth credentials:
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create OAuth 2.0 credentials (see [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed steps)
   - Copy your Client ID and Client Secret

3. Create Cloudflare resources:
   ```bash
   # Create D1 database
   npm run db:create openauth-template-auth-db
   
   # Create KV namespace
   npm run kv:create AUTH_STORAGE
   ```

4. Set up secrets:
   ```bash
   npm run setup:secrets
   # Enter your Google Client ID and Secret when prompted
   ```

5. Run database migrations:
   ```bash
   npm run migrate
   ```

6. Deploy to Cloudflare:
   ```bash
   npm run deploy
   ```

### Enhanced Features

This template now includes:

- **Google OAuth Integration**: Login with Google alongside email/password
- **Extended User Schema**: First name, last name, avatar, role, and addresses
- **Client SDK**: Easy frontend integration with TypeScript support
- **Authentication Middleware**: Route protection and role-based access control
- **Ecommerce Ready**: Database schema optimized for ecommerce applications

### Documentation

- **[DEPLOYMENT.md](./DEPLOYMENT.md)**: Complete deployment guide with Google OAuth setup
- **[ECOMMERCE_INTEGRATION.md](./ECOMMERCE_INTEGRATION.md)**: Integration guide for ecommerce applications
- **[examples/](./examples/)**: Working examples for frontend and API integration

### Monitoring

Monitor your deployed worker:
```bash
npm run logs
```

### ARM Architecture Support

**Important:** If you're on an ARM CPU (like Apple Silicon or Windows ARM), Wrangler's `workerd` package doesn't support ARM64 architecture. 

**Recommended for ARM users:** Use the **Direct Deployment Workflow** - see [DIRECT_DEPLOYMENT_WORKFLOW.md](./DIRECT_DEPLOYMENT_WORKFLOW.md) for a streamlined approach that lets you:
- Edit code locally on your ARM machine
- Deploy directly to Cloudflare Workers
- Test on live environment
- Keep our conversation going! 💬

Alternative approaches in [ARM_DEVELOPMENT_GUIDE.md](./ARM_DEVELOPMENT_GUIDE.md):
- GitHub Codespaces
- WSL2 on Windows  
- Docker containers
