import '@testing-library/jest-dom/vitest';
import { jsx } from 'react/jsx-runtime';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

// Mock next/image — elements go through the real jsx-runtime so React 19's
// transitional-element check accepts them (hand-built react.element objects
// are rejected as "older version" elements)
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => jsx('img', props),
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string }) => {
    return jsx('a', { ...props, children });
  },
}));

// Mock aws-amplify/auth — HERMETIC: any unmocked call throws
vi.mock('aws-amplify/auth', () => ({
  signIn: vi.fn().mockRejectedValue(new Error('UNMOCKED signIn')),
  confirmSignIn: vi.fn().mockRejectedValue(new Error('UNMOCKED confirmSignIn')),
  signOut: vi.fn().mockResolvedValue(undefined),
  getCurrentUser: vi.fn().mockRejectedValue(new Error('Not authenticated')),
  fetchAuthSession: vi.fn().mockResolvedValue({
    tokens: {
      idToken: {
        toString: () => 'mock-id-token',
        payload: {
          sub: 'user-123',
          email: 'test@cumplify.ai',
          'custom:tenantId': 'tenant-001',
          'custom:role': 'QualityManager',
          'custom:locale': 'en',
        },
      },
    },
  }),
}));

// Mock aws-amplify/api — HERMETIC
vi.mock('aws-amplify/api', () => ({
  generateClient: () => ({
    graphql: vi.fn().mockRejectedValue(new Error('UNMOCKED graphql call')),
  }),
}));

// Mock aws-amplify
vi.mock('aws-amplify', () => ({
  Amplify: {
    configure: vi.fn(),
  },
}));
