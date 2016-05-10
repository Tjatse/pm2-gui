function fib (n) {
  if (n === 1) return 1
  if (n === 0) return 0
  if (n > 1) return fib(n - 2) + fib(n - 1)
}

function fi () {
  console.log('fibonacci...')
  var f = fib((parseInt(Math.random() * 10000) + 30) % 42)
  console.log('is:', f)
  setTimeout(fi, 1000)
}
fi()
