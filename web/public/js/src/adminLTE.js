'use strict';

$(() => {
  moment.locale('zh-CN');
  $('.datetime').each(function() {
    let ele = $(this);
    ele.text(moment(parseFloat(ele.text())).format('MMMM Do YYYY'));
  });
});
