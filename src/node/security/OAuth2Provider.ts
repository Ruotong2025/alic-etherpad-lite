import {ArgsExpressType} from "../types/ArgsExpressType";
// OAuth2 functionality has been disabled
// All imports and code have been commented out to remove oidc-provider dependency

// import Provider, {Account, Configuration} from 'oidc-provider';
// import {generateKeyPair, exportJWK, KeyLike} from 'jose'
// import MemoryAdapter from "./OIDCAdapter";
// import path from "path";
// const settings = require('../utils/Settings');
// import {IncomingForm} from 'formidable'
// import express, {Request, Response} from 'express';
// import {format} from 'url'
// import {ParsedUrlQuery} from "node:querystring";
// import {Http2ServerRequest, Http2ServerResponse} from "node:http2";
// import {MapArrayType} from "../types/MapType";

// Placeholder exports to avoid breaking imports
export let publicKeyExported: any = null;
export let privateKeyExported: any = null;

/*
This function is used to initialize the OAuth2 provider
NOTE: OAuth2 functionality has been disabled. This is now a no-op function.
 */
export const expressCreateServer = async (hookName: string, args: ArgsExpressType, cb: Function) => {
    // OAuth2 functionality disabled
    console.log('OAuth2 functionality is disabled');
};
