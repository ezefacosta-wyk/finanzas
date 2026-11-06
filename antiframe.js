// Anti-clickjacking: si otra página muestra la app dentro de un marco, queda oculta
if(window.top===window.self){document.getElementById('antiFrame').remove();}else{try{window.top.location=window.self.location;}catch(e){}}
