// Authorization
action(function auth(req, res){
  if (!req._config.password || (req._config.password === req.session['password'])) {
    return res.redirect('/');
  }
  res.render('auth', {title: 'Authorization'});
});

// Index
action(function(req, res){
  if (req._config.password && (req._config.password !== req.session['password'])) {
    return res.redirect('/auth');
  }
  res.render('index', {title: 'Monitor'});
});

// API
action(function auth_api(req, res){
  if (!req.query || !req.query.pwd) {
    return res.json({error: 'Authorization failed, password is required!'});
  }

  if (req.query.pwd === req._config.password) {
    req.session['password'] = req.query.pwd;
    return res.json({status: 200});
  }
  return res.json({error: 'Authorization failed, password is incorrect.'});
});