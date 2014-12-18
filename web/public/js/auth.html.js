var btn, pwd, light, timer;

$(window).ready(function(){
  light = $('span');
  pwd = $('input:password');
  pwd.focus();

  // Login.
  pwd.keyup(function(e){
    if (e.keyCode == 13) {
      login();
    }
  });
  btn = $('a').click(login);
});

// Login event.
function login(){
  // Called one time.
  if (btn.hasClass('active')) {
    return;
  }
  var val = pwd.val().trim();
  if (!val) {
    pwd.focus();
    return;
  }

  // Post data to server.
  lightUp();
  $.ajax({
    url    : '/auth_api?t=' + Math.random(),
    data   : {
      pwd: val
    },
    dataType: 'json',
    error  : function(){
      info('Can not get response from server, it is an internal error.');
      lightOff();
    },
    success: function(res){
      lightOff();
      if(res.error){
        return info(res.error);
      }else{
        window.location.href = '/';
      }
    }
  });
};

// Beginning of AJAX.
function lightUp(){
  lightOff();
  btn.addClass('active');

  timer = setInterval(function(){
    light.toggleClass('active');
  }, 500);
}

// Ending of AJAX.
function lightOff(){
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  $('.active').removeClass('active');
}

// Show tips.
function info(msg){
  $.sticky({
    body         : msg,
    icon         : './img/info.png',
    useAnimateCss: true
  });
}