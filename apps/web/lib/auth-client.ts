import { createAuthClient } from 'better-auth/react';

// better-auth 1.7 ships no genericOAuthClient; the test-mode google/apple/microsoft/facebook sign-in is driven over REST by the e2e fixture.
export const authClient = createAuthClient();
