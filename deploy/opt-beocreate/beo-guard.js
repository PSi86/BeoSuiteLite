process.on('unhandledRejection', function(r){ try{ console.error('[guard] unhandledRejection:', (r && r.message) ? r.message : r); }catch(e){} });
process.on('uncaughtException', function(e){ try{ console.error('[guard] uncaughtException:', (e && e.message) ? e.message : e); }catch(x){} });
