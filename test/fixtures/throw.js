console.log('App started.');
setTimeout(function(){
  throw new Error('uncaughtException has been thrown.');
}, 15000);