'use strict';
/**
 * Controls the security of pad access
 */

/*
 * 2011 Peter 'Pita' Martischka (Primary Technology Ltd)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {UserSettingsObject} from "../types/UserSettingsObject";

const authorManager = require('./AuthorManager');
const hooks = require('../../static/js/pluginfw/hooks');
const padManager = require('./PadManager');
const readOnlyManager = require('./ReadOnlyManager');
const sessionManager = require('./SessionManager');
const settings = require('../utils/Settings');
const webaccess = require('../hooks/express/webaccess');
const log4js = require('log4js');
const authLogger = log4js.getLogger('auth');
import padutils from '../../static/js/pad_utils'

const DENY = Object.freeze({accessStatus: 'deny'});

/**
 * Determines whether the user can access a pad - PURE USERNAME-BASED, NO TOKEN
 *
 * @param padID identifies the pad the user wants to access.
 * @param sessionCookie identifies the sessions the user created via the HTTP API, if any.
 * @param userName REQUIRED - the username for identification (replaces token completely)
 * @param userSettings is the settings.users[username] object (or equivalent from an authn plugin).
 * @return {accessStatus: grant|deny, authorID: a.xxxxxx}. The caller must use the author ID
 *     returned in this object when making any changes associated with the author.
 *
 * @param {String} padID
 * @param {String} sessionCookie
 * @param {String} userName REQUIRED
 * @param {Object} userSettings
 * @return {DENY|{accessStatus: String, authorID: String}}
 */
exports.checkAccess = async (padID:string, sessionCookie:string, userName: string, userSettings:UserSettingsObject) => {
  if (!padID) {
    authLogger.debug('access denied: missing padID');
    return DENY;
  }

  if (!userName || userName.trim() === '') {
    authLogger.debug('access denied: userName is required (token-based auth disabled)');
    return DENY;
  }

  let canCreate = !settings.editOnly;

  if (readOnlyManager.isReadOnlyId(padID)) {
    canCreate = false;
    padID = await readOnlyManager.getPadId(padID);
    if (padID == null) {
      authLogger.debug('access denied: read-only pad ID for a pad that does not exist');
      return DENY;
    }
  }

  // Authentication and authorization checks.
  if (settings.loadTest) {
    console.warn(
        'bypassing socket.io authentication and authorization checks due to settings.loadTest');
  } else if (settings.requireAuthentication) {
    if (userSettings == null) {
      authLogger.debug('access denied: authentication is required');
      return DENY;
    }
    if (userSettings.canCreate != null && !userSettings.canCreate) canCreate = false;
    if (userSettings.readOnly) canCreate = false;
    // Note: userSettings.padAuthorizations should still be populated even if
    // settings.requireAuthorization is false.
    const padAuthzs = userSettings.padAuthorizations || {};
    const level = webaccess.normalizeAuthzLevel(padAuthzs[padID]);
    if (!level) {
      authLogger.debug('access denied: unauthorized');
      return DENY;
    }
    if (level !== 'create') canCreate = false;
  }

  // allow plugins to deny access (updated to pass userName instead of token)
  const isFalse = (x:boolean) => x === false;
  if (hooks.callAll('onAccessCheck', {padID, userName, sessionCookie}).some(isFalse)) {
    authLogger.debug('access denied: an onAccessCheck hook function returned false');
    return DENY;
  }

  const padExists = await padManager.doesPadExist(padID);
  if (!padExists && !canCreate) {
    authLogger.debug('access denied: user attempted to create a pad, which is prohibited');
    return DENY;
  }

  const sessionAuthorID = await sessionManager.findAuthorID(padID.split('$')[0], sessionCookie);
  if (settings.requireSession && !sessionAuthorID) {
    authLogger.debug('access denied: HTTP API session is required');
    return DENY;
  }

  // PURE USERNAME-BASED: Get author ID directly from userName
  let authorID;
  if (sessionAuthorID) {
    authorID = sessionAuthorID;
  } else {
    // NO TOKEN DEPENDENCY - pure userName-based identification
    authorID = await authorManager.getAuthorId(userName, userSettings);
    console.log(`[NO-TOKEN] Pure userName-based authorID: ${userName} -> ${authorID}`);
  }

  const grant = {
    accessStatus: 'grant',
    authorID,
  };

  if (!padID.includes('$')) {
    // Only group pads can be private, so there is nothing more to check for this non-group pad.
    return grant;
  }

  if (!padExists) {
    if (sessionAuthorID == null) {
      authLogger.debug('access denied: must have an HTTP API session to create a group pad');
      return DENY;
    }
    // Creating a group pad, so there is no public status to check.
    return grant;
  }

  const pad = await padManager.getPad(padID);

  if (!pad.getPublicStatus() && sessionAuthorID == null) {
    authLogger.debug('access denied: must have an HTTP API session to access private group pads');
    return DENY;
  }

  return grant;
}
