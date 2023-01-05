if (document.location.hostname.includes('wikipedia.org'))
{
    let content = document.getElementById('content');
    let infoboxes = document.getElementsByClassName('infobox');
    let links = document.getElementsByTagName('a');
    let tocs = document.getElementsByClassName('toc');

    content.style.backgroundColor = 'gray';
    content.style.color = 'white';

    for (let i = 0; i < infoboxes.length; i++)
    {
	    infoboxes[i].style.backgroundColor = 'gray';
	    infoboxes[i].style.color = 'white';
    }

    for (let i = 0; i < links.length; i++)
    {
	    if (links[i].href)
            links[i].style.color = 'aqua';
    }

    for (let i = 0; i < tocs.length; ++i)
    { 
        tocs[i].style.backgroundColor = 'gray';
        tocs[i].style.color = 'white';
    }
}

completion('ok');

