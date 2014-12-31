var chalk = require('chalk');
setInterval(function(){
  console.log(chalk.bold.green('Tick'), Date.now());
}, 1000);