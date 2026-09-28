// Preloaded into beo-server (node --require): keeps Beocreate 2 running when an
// extension throws or leaves a promise rejection unhandled. Logs the stack so the
// cause can be traced instead of only the message.
function describe(e) { return (e && e.stack) ? e.stack : ((e && e.message) ? e.message : String(e)); }
process.on('unhandledRejection', function(r){ try{ console.error('[guard] unhandledRejection:', describe(r)); }catch(e){} });
process.on('uncaughtException', function(e){ try{ console.error('[guard] uncaughtException:', describe(e)); }catch(x){} });
