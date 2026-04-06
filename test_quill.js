const Delta = require('quill-delta');
let d = new Delta([{insert: "Worl"}, {insert: "d"}]);
console.log(d.length());
let b = d.slice(0, d.length() - 1);
console.log(b);
