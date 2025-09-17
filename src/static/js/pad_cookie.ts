// @ts-nocheck
'use strict';

/**
 * Copyright 2009 Google Inc.
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

import {Cookies} from "./pad_utils";

exports.padcookie = new class {
  constructor() {
    this.cookieName_ = window.location.protocol === 'https:' ? 'prefs' : 'prefsHttp';
    this.localStorageKey_ = 'etherpad_prefs';
    // In userName-based system, prefer localStorage over cookies
    this.useLocalStorage_ = typeof Storage !== 'undefined';
  }

  init() {
    let prefs = this.readPrefs_() || {};
    delete prefs.userId;
    delete prefs.name;
    delete prefs.colorId;
    this.writePrefs_(prefs);
    
    // Simple check - if no storage available at all, warn user
    if (!this.useLocalStorage_ && this.readPrefs_() == null) {
      console.warn('[PADCOOKIE] No storage available for preferences');
      $.gritter.add({
        title: 'Notice',
        text: 'Browser storage not available. Preferences will not be saved.',
        sticky: false,
        time: 3000,
        class_name: 'warning',
      });
    }
  }

  readPrefs_() {
    // In userName-based system, prefer localStorage over cookies
    if (this.useLocalStorage_) {
      try {
        const json = localStorage.getItem(this.localStorageKey_);
        if (json != null) {
          return JSON.parse(json);
        }
      } catch (e) {
        console.warn('[PADCOOKIE] localStorage read failed:', e);
      }
    }

    // Fallback to cookies if localStorage not available
    try {
      const json = Cookies.get(this.cookieName_);
      if (json != null) {
        return JSON.parse(json);
      }
    } catch (e) {
      console.warn('[PADCOOKIE] Cookie read failed:', e);
    }

    return null;
  }

  writePrefs_(prefs) {
    // In userName-based system, prefer localStorage over cookies
    if (this.useLocalStorage_) {
      try {
        localStorage.setItem(this.localStorageKey_, JSON.stringify(prefs));
        return;
      } catch (e) {
        console.warn('[PADCOOKIE] localStorage write failed:', e);
      }
    }

    // Fallback to cookies if localStorage not available
    try {
      Cookies.set(this.cookieName_, JSON.stringify(prefs), {expires: 365 * 100});
      return;
    } catch (e) {
      console.warn('[PADCOOKIE] Cookie write failed:', e);
    }
  }

  getPref(prefName) {
    const prefs = this.readPrefs_();
    return prefs ? prefs[prefName] : null;
  }

  setPref(prefName, value) {
    const prefs = this.readPrefs_() || {};
    prefs[prefName] = value;
    this.writePrefs_(prefs);
  }

  clear() {
    this.writePrefs_({});
  }
}();
