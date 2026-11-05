-- Below 079 the data-fix rule does not apply: this statement is not reported.
update fixture_rows set flag = true where flag is null;
