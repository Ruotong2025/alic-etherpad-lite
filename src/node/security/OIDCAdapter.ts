// OAuth2/OIDC functionality has been disabled
// This file is kept for compatibility but all functionality is removed

// import {LRUCache} from 'lru-cache';
// import type {Adapter, AdapterPayload} from "oidc-provider";

// Placeholder class to avoid breaking imports
class MemoryAdapter {
    constructor(name: string) {
        console.log('OIDC MemoryAdapter is disabled');
    }
}

export default MemoryAdapter;
