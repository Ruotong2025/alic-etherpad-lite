'use strict';
const securityManager = require('./db/SecurityManager');

// checks for padAccess
module.exports = async (req: { params?: any; cookies?: any; session?: any; }, res: { status: (arg0: number) => { (): any; new(): any; send: { (arg0: string): void; new(): any; }; }; }) => {
  const {session: {user} = {}} = req;
  // Use a default userName when authentication is not required
  const userName = req.cookies.token || 'anonymous';
  const accessObj = await securityManager.checkAccess(
      req.params.pad, req.cookies.sessionID, userName, user);

  if (accessObj.accessStatus === 'grant') {
    // there is access, continue
    return true;
  } else {
    // no access
    res.status(403).send("403 - Can't touch this");
    return false;
  }
};
