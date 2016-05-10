var chalk = require('chalk')

console.log('This is', chalk.bold.red('red'))
console.log('This is', chalk.dim.green('green'))
console.log('This is', chalk.bold.green('green'))
console.log('This is', chalk.bold.italic.yellow('yellow'))
console.log('This is', chalk.bold.strikethrough.blue('blue'))
console.log('This is', chalk.bold.underline.magenta('magenta'))
console.log('This is', chalk.bold.cyan('cyan'))
console.log('This is', chalk.bold.grey('grey'))

setTimeout(function () {}, 3000000)
