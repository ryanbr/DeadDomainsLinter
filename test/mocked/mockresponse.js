const createSuccessResponse = (deadDomains, activeDomains = []) => {
    const responseData = {};

    deadDomains.forEach((domain) => {
        responseData[domain] = {
            info: {
                domain_name: domain,
                registered_domain: domain,
                registered_domain_used_last_24_hours: false,
                used_last_24_hours: false,
            },
            matches: [],
        };
    });

    activeDomains.forEach((domain) => {
        responseData[domain] = {
            info: {
                domain_name: domain,
                registered_domain: domain,
                registered_domain_used_last_24_hours: true,
                used_last_24_hours: true,
            },
            matches: [],
        };
    });

    return {
        status: 200,
        ok: true,
        headers: { get: () => 'application/json' },
        json: jest.fn().mockResolvedValue(responseData),
    };
};

const createRateLimitedResponse = (retryAfterValue) => ({
    status: 429,
    ok: false,
    headers: {
        get: jest.fn((headerName) => {
            const headers = {
                'retry-after': retryAfterValue,
                'content-type': 'application/json',
            };
            return headers[headerName.toLowerCase()];
        }),
    },
    json: jest.fn().mockResolvedValue({
        error: 'Too many requests',
        message: 'Rate limit exceeded',
    }),
});

module.exports = {
    createSuccessResponse,
    createRateLimitedResponse,
};
