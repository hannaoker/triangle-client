#!/usr/bin/perl
# Trusted bootstrap: bounded regular-file-only ustar reader. No archive code runs
# until the independent archive checksum and complete manifest are verified.
use strict; use warnings;
use Digest::SHA qw(sha256_hex); use JSON::PP; use IO::Uncompress::Gunzip;
use Fcntl qw(:DEFAULT :mode); use File::Path qw(make_path); use Cwd qw(realpath); use File::Spec;
my ($archive,$expected,$stage,$test_root)=@ARGV;
die "Expected SHA256 must be 64 hex digits\n" unless defined($expected)&&$expected=~/\A[a-fA-F0-9]{64}\z/;
if(length($test_root||'')){
 my $temp=realpath(File::Spec->tmpdir()); my $root=realpath($test_root)||'';
 die "Unsafe test root\n" unless $root eq $test_root && $root=~m{\A\Q$temp\E/triangle-package-install-[^/]+\z};
 for my $dir ($root,"$root/home") {my @s=lstat($dir);die "Unsafe test directory\n" unless @s&&S_ISDIR($s[2])&&$s[4]==$<&&($s[2]&0777)==0700&&realpath($dir) eq $dir;}
}
sysopen(my $input,$archive,O_RDONLY|O_NOFOLLOW) or die "Cannot open archive: $!\n";
my @s=stat($input);die "Archive must be a bounded regular file\n" unless S_ISREG($s[2])&&$s[7]<=512*1024*1024;
my $digest=Digest::SHA->new(256);$digest->addfile($input);die "Archive SHA256 mismatch\n" unless $digest->hexdigest eq lc($expected);
seek($input,0,0) or die "Cannot rewind archive\n";
my $zip=IO::Uncompress::Gunzip->new($input,MultiStream=>0) or die "Invalid gzip archive\n";
sub exact {my ($count)=@_;my $data='';while(length($data)<$count){my $n=$zip->read(my $part,$count-length($data));die "Truncated archive\n" unless defined($n)&&$n>0;$data.=$part;}return $data;}
sub field {my ($header,$offset,$size)=@_;my $str=substr($header,$offset,$size);$str=~s/\0.*\z//s;return $str;}
my %actual; my $total=0;my $manifest;
while(1){
 my $header=exact(512);last if $header eq "\0"x512;
 die "Too many archive entries\n" if keys(%actual)>=10000;
 my $name=field($header,0,100);my $prefix=field($header,345,155);$name="$prefix/$name" if length($prefix);
 die "Unsafe archive path\n" unless $name=~/\A[a-zA-Z0-9_.\/-]+\z/&&$name!~m{\A/}&&!grep {$_ eq ''||$_ eq '.'||$_ eq '..'} split(m{/},$name,-1);
 die "Duplicate archive path\n" if exists($actual{$name});
 my $type=substr($header,156,1);die "Only regular files are accepted\n" unless $type eq '0'||$type eq "\0";
 my $sizefield=substr($header,124,12);die "Invalid archive size\n" unless $sizefield=~/\A[0-7 ]+\0?\z/;my $size=oct($sizefield);
 $total+=$size;die "Expanded archive is too large\n" if $total>1024*1024*1024;
 die "Oversized manifest\n" if $name eq 'package-manifest.json'&&$size>2*1024*1024;
 my $check=field($header,148,8);$check=~s/\s//g;die "Invalid tar checksum\n" unless $check=~/\A[0-7]+\z/;
 my $copy=$header;substr($copy,148,8)=' 'x8;die "Tar header checksum mismatch\n" unless unpack('%32C*',$copy)==oct($check);
 my $target="$stage/$name";my ($directory)=$target=~m{\A(.*)/[^/]+\z};make_path($directory,{mode=>0700});
 sysopen(my $out,$target,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600) or die "Unsafe extraction target: $!\n";
 my $hash=Digest::SHA->new(256);my $left=$size;my $json='';
 while($left){my $chunk=exact($left>1024*1024?1024*1024:$left);$left-=length($chunk);$hash->add($chunk);print {$out} $chunk or die "Extraction failed\n";$json.=$chunk if $name eq 'package-manifest.json';}close($out) or die "Extraction failed\n";
 exact((512-$size%512)%512) if $size%512;
 $actual{$name}={size=>$size,sha256=>$hash->hexdigest};$manifest=decode_json($json) if $name eq 'package-manifest.json';
}
die "Missing manifest\n" unless ref($manifest) eq 'HASH';
my $arch=`/usr/bin/uname -m`;chomp($arch);$arch='x64' if $arch eq 'x86_64';
die "Unsupported package platform or architecture\n" unless $^O eq 'darwin'&&($manifest->{platform}||'') eq 'darwin'&&($manifest->{arch}||'') eq $arch;
die "Unsafe package version\n" unless ($manifest->{version}||'')=~/\A[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?\z/;
die "Unsupported package contract\n" unless ($manifest->{schema}||0)==1&&($manifest->{signingMode}||'') eq 'public_ad_hoc'&&($manifest->{credentialCustody}||'') eq 'file';
die "Test package cannot enter real account\n" if $manifest->{testOnly}&&!length($test_root||'');
die "Invalid manifest\n" unless ref($manifest->{files}) eq 'ARRAY';my %listed;
for my $entry (@{$manifest->{files}}){my $path=$entry->{path};die "Manifest closure mismatch\n" unless defined($path)&&exists($actual{$path})&&$path ne 'package-manifest.json'&&!$listed{$path}++;
 die "Manifest metadata mismatch\n" unless $entry->{size}==$actual{$path}{size}&&$entry->{sha256} eq $actual{$path}{sha256}&&($entry->{mode}==0600||$entry->{mode}==0700);
 chmod($entry->{mode},"$stage/$path") or die "Cannot set payload mode\n";
}
die "Unmanifested archive entry\n" unless keys(%listed)+1==keys(%actual);
for my $required ('bin/node','bin/triangle-mailbox','bin/triangle-client','packages/triangle-cli/src/cli.mjs','scripts/release/install-client-package.mjs'){die "Incomplete package\n" unless $listed{$required};}
