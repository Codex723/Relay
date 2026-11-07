// Test-only secrets. Never used outside the test run.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ??= "test-access-secret-0123456789abcdef0123456789";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret-fedcba9876543210fedcba98765";
process.env.PAYSTACK_SECRET_KEY ??= "sk_test_fake_key_for_automated_tests_only";
process.env.WEB_ORIGIN ??= "http://localhost:3000";
