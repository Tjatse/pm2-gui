var btn, pwd, light, timer;

$(window).ready(function () {
  light = $('span');
  pwd = $('input:password');
  pwd.focus();

  // Login.
  pwd.keyup(function (e) {
    if (e.keyCode == 13) {
      login();
    }
  });
  btn = $('a').click(login);

  drawLogo();
});

// Login event.
function login() {
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
    url: 'auth_api?t=' + Math.random(),
    data: {
      authorization: val
    },
    dataType: 'json',
    error: function () {
      info('Can not get response from server, it is an internal error.');
      lightOff();
    },
    success: function (res) {
      lightOff();
      if (res.error) {
        return info(res.error);
      } else {
        window.location.href = '/';
      }
    }
  });
};

// Beginning of AJAX.
function lightUp() {
  lightOff();
  btn.addClass('active');

  timer = setInterval(function () {
    light.toggleClass('active');
  }, 500);
}

// Ending of AJAX.
function lightOff() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  $('.active').removeClass('active');
}

// Show tips.
function info(msg) {
  $.sticky({
    body: msg,
    icon: './img/info.png',
    useAnimateCss: true
  });
}

function drawLogo() {
  var w = 80,
    h = 32;

  var svg = d3.select('#logo')
    .append('svg')
    .attr('width', w)
    .attr('height', h);

  var filter = svg.append('defs')
    .append('filter')
    .attr('id', 'dropshadow')

  filter.append('feGaussianBlur')
    .attr('in', 'SourceAlpha')
    .attr('stdDeviation', 1)
    .attr('result', 'blur');
  filter.append('feOffset')
    .attr('in', 'blur')
    .attr('dx', 4)
    .attr('dy', 4)
    .attr('result', 'offsetBlur')
  filter.append('feFlood')
    .attr('in', 'offsetBlur')
    .attr('flood-color', '#0a6506')
    .attr('flood-opacity', '0.9')
    .attr('result', 'offsetColor');
  filter.append('feComposite')
    .attr('in', 'offsetColor')
    .attr('in2', 'offsetBlur')
    .attr('operator', 'in')
    .attr('result', 'offsetBlur');

  var feMerge = filter.append('feMerge');

  feMerge.append('feMergeNode')
    .attr('in', 'offsetBlur')
  feMerge.append('feMergeNode')
    .attr('in', 'SourceGraphic');

  var vis = svg
    .append('g')
    .attr('width', w)
    .attr('height', h);

  vis.append('path')
    .style('fill', 'none')
    .style('stroke', '#fff')
    .style('stroke-width', 2)
    .attr('d', 'M24,12 T16,8 T4,16 T16,28 T24,20 T18,20 T28,18 T30,16 T44,24 T48,16 T58,8 L58,28 T62,16 T68,16 T72,16 T76,16')
    .attr('filter', 'url(#dropshadow)');
}
